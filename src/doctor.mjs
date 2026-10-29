import path from 'node:path';

import { absoluteFor, resolveLayout } from './paths.mjs';
import { captureState, parseProfile, ProfileJsonError } from './state.mjs';
import { analyzePatch } from './yamlpatch.mjs';
import { satisfies } from './semver-lite.mjs';
import { readText } from './fsx.mjs';
import { nextMarkers, readFromAsar, resolveAppPackage } from './installation.mjs';

const DSH_PREFIX = '@deepseek-ai/dsh';

export function isShippedBundle(name) {
  return typeof name === 'string' && name.startsWith(DSH_PREFIX);
}

export function packageDirFor(profileDir, name) {
  return path.join(profileDir, 'node_modules', ...String(name).split('/'));
}

export function readManifest(profileDir, name) {
  const text = readText(path.join(packageDirFor(profileDir, name), 'package.json'));
  if (text === null) return { present: false, manifest: null };
  try {
    return { present: true, manifest: JSON.parse(text) };
  } catch {
    return { present: true, manifest: null, invalid: true };
  }
}

/** Where a package directory is, and how to read a file beside it. */
function packageReader({ profileDir, name, asarPaths }) {
  const local = readManifest(profileDir, name);
  if (local.present && local.manifest) {
    return {
      origin: 'profile',
      manifest: local.manifest,
      read: (rel) => {
        try {
          return readText(path.resolve(packageDirFor(profileDir, name), rel));
        } catch {
          return null;
        }
      },
    };
  }
  if (local.present && !local.manifest) return { origin: 'profile', manifest: null, invalid: true };

  const app = resolveAppPackage({ name, asarPaths });
  if (!app) return null;
  if (app.origin === 'app-unpacked') {
    const base = path.join(`${app.asarPath}.unpacked`, 'node_modules', ...String(name).split('/'));
    return {
      origin: app.origin,
      manifest: app.manifest,
      read: (rel) => readText(path.join(base, String(rel).replace(/^[./\\]+/, ''))),
    };
  }
  return {
    origin: app.origin,
    manifest: app.manifest,
    read: (rel) => {
      const buffer = readFromAsar(app.asarPath, app.prefix ?? '', `node_modules/${name}/${rel}`);
      return buffer ? buffer.toString('utf8') : null;
    },
  };
}

/**
 * Every entry id the enabled bundles declare in their own patch files.
 *
 * Bundles can live in the profile *or* inside an app archive (DSH NEXT injects
 * some of its own), so both are read. `complete: false` means a layer could not
 * be read at all, and callers must not report "unknown id" findings then.
 */
export function collectKnownIds({ profileDir, bundleNames = [], asarPaths = [] }) {
  const ids = new Set();
  let complete = bundleNames.length > 0;
  for (const name of bundleNames) {
    const located = packageReader({ profileDir, name, asarPaths });
    if (!located || !located.manifest) {
      complete = false;
      continue;
    }
    const declared = located.manifest.dsh && located.manifest.dsh.bundle ? located.manifest.dsh.bundle.patch : undefined;
    if (declared === undefined || declared === null) continue;
    const list = Array.isArray(declared) ? declared : [declared];
    for (const rel of list) {
      if (typeof rel !== 'string') continue;
      const text = located.read(rel);
      if (text === null) {
        complete = false;
        continue;
      }
      for (const id of analyzePatch(text).ids) ids.add(id);
    }
  }
  return { ids, complete };
}

function requirementOf(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const engines = manifest.engines;
  if (engines !== undefined && (engines === null || typeof engines !== 'object' || Array.isArray(engines))) {
    return { malformed: 'engines 不是对象' };
  }
  if (engines && typeof engines === 'object' && Object.hasOwn(engines, 'dsh')) {
    if (typeof engines.dsh !== 'string') return { malformed: 'engines.dsh 不是字符串' };
    return { range: engines.dsh, source: 'engines.dsh' };
  }
  const peers = manifest.peerDependencies;
  if (!peers || typeof peers !== 'object') return null;
  const entries = Object.entries(peers).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith(DSH_PREFIX),
  );
  if (entries.length === 0) return null;
  return { peers: entries, source: 'peerDependencies' };
}

/**
 * Static pre-flight. Nothing here imports or executes a plugin: it reads
 * manifests, the app archive and the two YAML layers.
 */
export function runDoctor({
  home,
  profile = 'desktop',
  layout,
  runtimeVersion = null,
  state = null,
  knownIds = null,
  asarPaths = [],
  instances = null,
} = {}) {
  const resolved = layout ?? resolveLayout({ home, profile });
  const findings = [];
  const add = (level, code, message, hint) => findings.push({ level, code, message, ...(hint ? { hint } : {}) });

  const captured = state ?? captureState({ home: resolved.home, profile: resolved.profile, layout: resolved });
  const byKey = (key) => captured.files.find((file) => file.key === key) ?? null;

  const profileFile = byKey('profilePackage');
  let parsed = null;
  if (!profileFile || !profileFile.exists) {
    if (profileFile && profileFile.required && !profileFile.readable) {
      add('error', 'profile.unreadable', `读不到 ${profileFile.rel}：${profileFile.error ?? '未知错误'}`);
    } else {
      add(
        'error',
        'profile.missing',
        `找不到 ${resolved.profileDir}${path.sep}package.json —— 这个 profile 还没初始化过`,
        '先启动一次 DSH 让它初始化 profile，或确认 --profile 名字没写错',
      );
    }
  } else {
    try {
      parsed = parseProfile(profileFile.text);
    } catch (error) {
      const detail = error instanceof ProfileJsonError ? error.message : String(error);
      add(
        'error',
        'profile.json.invalid',
        detail,
        '这份 JSON 只能手修或从快照还原；dsh-rescue rescue 会用最近一次 good 覆盖它',
      );
    }
  }

  const bundles = parsed ? parsed.bundles : [];
  const dependencies = parsed ? parsed.dependencies : {};
  const bundleNames = [...new Set(bundles)];

  if (parsed) {
    if (parsed.bundlesRaw === null) {
      add('error', 'bundles.missing', 'package.json 里没有 dsh.profile.bundles —— 宿主不知道要挂哪些 bundle');
    } else if (!Array.isArray(parsed.bundlesRaw)) {
      add('error', 'bundles.notArray', 'dsh.profile.bundles 不是数组');
    } else if (parsed.bundlesRaw.length === 0) {
      add('warn', 'bundles.empty', 'dsh.profile.bundles 是空的：DSH 会起一个没有插件的空壳');
    }
    const duplicates = bundles.filter((name, index) => bundles.indexOf(name) !== index);
    if (duplicates.length > 0) {
      add('warn', 'bundles.duplicate', `bundles 里有重复项：${[...new Set(duplicates)].join(', ')}`);
    }

    const markers = nextMarkers({ profileDir: resolved.profileDir, packageJson: parsed.raw });
    if (markers.length > 0) {
      add(
        'info',
        'profile.sharedWithNext',
        `这份 profile 同时被 DSH NEXT 使用（${markers.slice(0, 3).join('、')}）`,
        '还原较早的快照可能会去掉 NEXT 注入的 bundle 与 desktopNext* 键；NEXT 下次启动一般会补回，但顺序可能变',
      );
    }
  }

  let gateUnknownReported = false;
  for (const name of bundleNames) {
    const inDeps = Object.hasOwn(dependencies, name);
    const located = packageReader({ profileDir: resolved.profileDir, name, asarPaths });

    if (!located) {
      if (inDeps) {
        add(
          'error',
          'bundle.missing',
          `${name} 在 dependencies 里，但 node_modules 里没有它的目录`,
          '装包掉了：重跑一次原来的 dsh plugin add，或从快照还原后重启',
        );
      } else if (!isShippedBundle(name)) {
        add('warn', 'bundle.notInstalled', `${name} 既不在 dependencies 里也没装，宿主会跳过它`);
      }
      continue;
    }
    if (located.invalid || !located.manifest) {
      add('warn', 'bundle.manifestInvalid', `${name} 的 package.json 读不出来或是坏 JSON`);
      continue;
    }

    const manifest = located.manifest;
    if (located.origin !== 'profile') {
      // Shipped bundles are supposed to live in the app; only third-party ones
      // resolved from an archive are worth pointing out.
      if (!isShippedBundle(name)) {
        add(
          'info',
          'bundle.fromApp',
          `${name}@${manifest.version ?? '?'} 来自安装包（不是 profile 里的依赖），宿主会从应用目录加载它`,
        );
      }
    } else {
      if (typeof manifest.name === 'string' && manifest.name !== name) {
        add('error', 'bundle.nameMismatch', `${name} 的 package.json 里 name 是 ${manifest.name}，与 bundles 里的键不一致`);
      }
      if (!inDeps && !isShippedBundle(name)) {
        add('warn', 'bundle.notInDeps', `${name} 不在 dependencies 里（bundles 与依赖清单不一致）`);
      }
    }

    const requirement = requirementOf(manifest);
    if (requirement && requirement.malformed) {
      add('error', 'gate.malformed', `${name} 的清单格式非法：${requirement.malformed}`);
      continue;
    }
    if (!requirement) continue;
    if (!runtimeVersion) {
      if (!gateUnknownReported) {
        gateUnknownReported = true;
        add(
          'info',
          'gate.unknown',
          '没有探测到 DSH 运行时版本，跳过所有插件的版本闸门检查',
          '用 --runtime <版本> 指定；不填会自动从安装目录的 app.asar 里读',
        );
      }
      continue;
    }
    const originLabel = located.origin === 'profile' ? '' : '（安装包）';
    if (requirement.range !== undefined) {
      if (!satisfies(runtimeVersion, requirement.range)) {
        add(
          'error',
          'gate.incompatible',
          `${name}@${manifest.version ?? '?'}${originLabel} 要求 engines.dsh ${requirement.range}，当前运行时 ${runtimeVersion}`,
          '要么升级/降级插件，要么 dsh plugin allow-version 显式豁免（承认崩溃风险），要么让 rescue 回滚',
        );
      }
      continue;
    }
    for (const [peer, range] of requirement.peers) {
      if (!satisfies(runtimeVersion, range)) {
        add(
          'error',
          'gate.incompatible',
          `${name}@${manifest.version ?? '?'}${originLabel} 要求 ${peer} ${range}，当前运行时 ${runtimeVersion}`,
          '同上：升/降插件、显式豁免，或回滚',
        );
      }
    }
  }

  for (const [name, spec] of Object.entries(dependencies)) {
    const { present, invalid, manifest } = readManifest(resolved.profileDir, name);
    if (!present) {
      add('warn', 'dep.missing', `dependencies 里的 ${name} 没装到 node_modules`, `重跑 dsh plugin add ${name}，或从快照还原`);
      continue;
    }
    if (invalid || !manifest) continue;
    if (typeof manifest.name === 'string' && manifest.name !== name) {
      add('error', 'dep.keyMismatch', `依赖键 ${name} 与包实际 name ${manifest.name} 不一致`, 'Desktop 有一致性校验，这会让启动进恢复模式；改成包真实 name');
    }
    const looksLikePlugin = manifest.dsh && typeof manifest.dsh === 'object';
    if (looksLikePlugin && !bundleNames.includes(name) && !bundleNames.includes(manifest.name)) {
      add('info', 'dep.notEnabled', `${name} 装了但不在 bundles 里（等于没启用）`);
    }
    void spec;
  }

  for (const entry of captured.installed) {
    if (entry.broken) add('warn', 'installed.broken', `node_modules 里 ${entry.name} 的 package.json 读不出来`);
  }

  const patchFile = byKey('profilePatch');
  let patchInfo = null;
  if (patchFile && !patchFile.exists) {
    add('info', 'patch.missing', `${patchFile.rel} 不存在（下次启动会重建一个空 patch）`);
  } else if (patchFile && !patchFile.readable) {
    add('error', 'patch.unreadable', `读不到 ${patchFile.rel}：${patchFile.error ?? '未知错误'}`);
  } else if (patchFile) {
    patchInfo = analyzePatch(patchFile.text);
    patchInfo.binary = patchFile.text.includes('\u0000');
    if (patchInfo.binary) {
      add('error', 'patch.binary', `${patchFile.rel} 里有 NUL 字节，像是写坏了`);
    }
    if (patchInfo.blank) {
      add(
        'error',
        'patch.empty',
        `${patchFile.rel} 是空的 —— 空 patch 会让启动直接失败（这一点很容易踩）`,
        '要么写 [] 表示"停用整个补丁层"，要么从快照还原',
      );
    } else if (patchInfo.commentsOnly) {
      add('error', 'patch.commentsOnly', `${patchFile.rel} 只有注释，等价于空文件，也会让启动失败`, '补一行 []，或从快照还原');
    }
    if (patchInfo.hasTabIndent) {
      add('warn', 'patch.tabIndent', `${patchFile.rel} 里有用 Tab 缩进的行，YAML 不允许用 Tab 缩进`);
    }
    if (patchInfo.ids.length > 0 && knownIds) {
      const idSet = knownIds instanceof Set ? knownIds : knownIds.ids;
      const complete = knownIds instanceof Set ? true : knownIds.complete !== false;
      if (!complete) {
        add('info', 'patch.idsUnverified', `${patchFile.rel} 里有 ${patchInfo.ids.length} 个 id，但有 bundle 的补丁读不到，跳过"未知 id"检查`);
      } else {
        const unknown = patchInfo.ids.filter((id) => !idSet.has(id));
        for (const id of [...new Set(unknown)]) {
          add('info', 'patch.unknownId', `${patchFile.rel} 里的 id "${id}" 不在任何已启用 bundle 的补丁里（宿主只会 warn）`);
        }
      }
    }
    if (patchInfo.duplicates.length > 0) {
      add('warn', 'patch.duplicateId', `${patchFile.rel} 里有重复 id：${patchInfo.duplicates.join(', ')}`);
    }
  }

  const compatFile = byKey('profileCompat');
  let compat = null;
  if (compatFile && compatFile.exists && compatFile.readable) {
    try {
      compat = JSON.parse(compatFile.text);
      if (!compat || typeof compat !== 'object' || Array.isArray(compat)) throw new Error('顶层不是对象');
    } catch (error) {
      compat = null;
      add('warn', 'compat.invalid', `${compatFile.rel} 不是合法 JSON：${error.message}`, '这份文件坏了会让豁免写入被拒，但不阻止启动');
    }
  }
  if (compat && typeof compat === 'object') {
    const installedVersions = new Map(captured.installed.map((entry) => [entry.name, entry.version]));
    for (const key of Object.keys(compat)) {
      const at = key.lastIndexOf('@');
      if (at <= 0) {
        add('warn', 'compat.badKey', `${compatFile.rel} 里的键 "${key}" 不是 pkg@version 形式`);
        continue;
      }
      const name = key.slice(0, at);
      const version = key.slice(at + 1);
      const actual = installedVersions.get(name);
      if (actual && actual !== version) {
        add('warn', 'compat.stale', `版本豁免 ${key} 已过期：现在装的是 ${name}@${actual}，豁免不会自动继承`, `重新授权：dsh plugin allow-version ${name}@${actual}`);
      }
    }
  }

  const homesPatch = byKey('homePatch');
  if (homesPatch && homesPatch.exists && homesPatch.readable) {
    const info = analyzePatch(homesPatch.text);
    if (info.blank || info.commentsOnly) {
      add('error', 'patch.empty', `${homesPatch.rel}（家目录级，优先级最高）是空的/只有注释，会让启动失败`);
    }
    if (info.ids.length > 0) {
      add('info', 'patch.homeLayer', `家目录级补丁层有 ${info.ids.length} 个条目，它的优先级高于 profile 级`);
    }
  }

  if (instances && instances.main > 0 && instances.next > 0) {
    add(
      'warn',
      'instances.dualHome',
      '主应用和 DSH NEXT 同时在跑，它们共用同一个 profile：两个宿主、两套 HMR、两套插件实例会互相覆盖状态文件（"插件在抢文件"多半就是这个）',
      '救援前只留一个应用；切换应用时先关掉另一个',
    );
  }

  const errorsCount = findings.filter((finding) => finding.level === 'error').length;
  const warningsCount = findings.filter((finding) => finding.level === 'warn').length;
  const infosCount = findings.filter((finding) => finding.level === 'info').length;

  return {
    ok: errorsCount === 0,
    findings,
    errorsCount,
    warningsCount,
    infosCount,
    summary: {
      home: resolved.home,
      profile: resolved.profile,
      profileDir: resolved.profileDir,
      bundles: bundleNames.length,
      dependencies: Object.keys(dependencies).length,
      installed: captured.installed.length,
      patchEntries: patchInfo ? patchInfo.entryCount : null,
      patchBytes: patchFile && patchFile.exists ? patchFile.bytes : null,
      runtimeVersion,
      bundlesList: bundleNames,
      appBundles: findings.filter((finding) => finding.code === 'bundle.fromApp').length,
      instances: instances ?? null,
    },
    state: captured,
    layout: resolved,
  };
}

export { absoluteFor };