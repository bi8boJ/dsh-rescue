import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { resolveLayout } from './paths.mjs';
import { captureState } from './state.mjs';
import { collectKnownIds, runDoctor } from './doctor.mjs';
import { detectRuntime, asarCandidates } from './runtime.mjs';
import { asarFromProfileOverlays } from './installation.mjs';
import { latestCrash } from './crash.mjs';
import { createSnapshot, appendJournal, getGood, listSnapshots, readSnapshot } from './snapshots.mjs';
import { describeDiff, diffStates } from './diff.mjs';
import { DshRunningError, restoreSnapshot, safeMode, undoLast } from './restore.mjs';
import { isDshRunning, summarizeInstances } from './processes.mjs';
import { createUi, formatTime, humanBytes, relativeTime } from './ui.mjs';
import { resolveAppExecutable } from './app.mjs';
import { DEFAULT_BOOT_TIMEOUT_MS, launchGuarded } from './launcher.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

const VALUE_FLAGS = new Map([
  ['--home', 'home'],
  ['--profile', 'profile'],
  ['--runtime', 'runtime'],
  ['--dsh', 'dsh'],
  ['--asar', 'asar'],
  ['--app', 'app'],
  ['--boot-timeout', 'bootTimeout'],
  ['--retention', 'retention'],
  ['-m', 'label'],
  ['--message', 'label'],
  ['--label', 'label'],
]);

const BOOL_FLAGS = new Map([
  ['--json', 'json'],
  ['--yes', 'yes'],
  ['-y', 'yes'],
  ['--dry-run', 'dryRun'],
  ['--force', 'force'],
  ['--no-auto-restore', 'noAutoRestore'],
  ['--help', 'help'],
  ['-h', 'help'],
  ['--version', 'version'],
  ['-v', 'version'],
]);

const USAGE = `dsh-rescue ${PACKAGE.version} —— DSH 插件配置急救工具

用法: dsh-rescue <命令> [选项]

命令:
  launch              看门狗启动：N 秒没就绪就杀掉、回滚到上次可用、再试一次
  status              总览：体检 + 最近崩溃 + 与上次可用状态的差异
  doctor              只做静态体检（有错误时退出码 1）
  save                给当前状态打一份快照
  good                把当前状态标记为"已知可用"（体检不过会拒绝）
  rescue              一键救援：存现场 → 回到最近可用的状态 → 报告撤销了什么
  restore <快照>      还原指定快照（last | good | 完整 id | id 前缀）
  safe-mode           只保留出厂 bundle（可一键撤回）
  undo                撤回上一次写操作
  list                列出快照
  diff [a] [b]        两个状态之间的差异（默认 good → 当前）
  crash               打印最近一次崩溃报告的要点
  menu                交互菜单（双击 .cmd 时默认走这里）

选项:
  --home <目录>        DSH_HOME，默认 $DSH_HOME 或 ~/.dsh
  --profile <名字>     profile 名，默认 desktop
  --runtime <版本>     直接指定 DSH 运行时版本（跳过探测）
  --dsh <可执行文件>   dsh CLI 路径（用于探测版本）
  --asar <app.asar>    额外读一个安装包（比如 DSH NEXT 的），用来解析它内置的 bundle
  --app <可执行文件>  要启动的 DSH 应用（默认自动找）
  --boot-timeout <秒> 看门狗等多久算卡死，默认 90
  --no-auto-restore   卡死时只杀不回滚（默认会回滚到最近 good）
  --retention <数量>   非 good 快照保留多少个，默认 30
  --json               机器可读输出
  --yes                跳过确认
  --dry-run            只打印计划，不写任何文件
  --force              DSH 正在跑也照写 / 体检不过也标记 good
  --version, --help

安全承诺:
  · 任何写操作前先打快照，被覆盖的文件留 .pre-<时间戳> 副本
  · patch 文件只追加行，绝不重排；整层停用写 [] 而不是留空
  · 不碰 node_modules、sessions、storages、记忆库；不联网`;

class UsageError extends Error {}

export function parseArgs(argv = []) {
  const options = {
    json: false,
    yes: false,
    dryRun: false,
    force: false,
    help: false,
    version: false,
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const at = arg.indexOf('=');
      const flag = arg.slice(0, at);
      const value = arg.slice(at + 1);
      if (!VALUE_FLAGS.has(flag)) throw new UsageError(`未知选项 ${flag}`);
      options[VALUE_FLAGS.get(flag)] = value;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${arg} 需要一个值`);
      options[VALUE_FLAGS.get(arg)] = String(value);
      index += 1;
      continue;
    }
    if (BOOL_FLAGS.has(arg)) {
      options[BOOL_FLAGS.get(arg)] = true;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') throw new UsageError(`未知选项 ${arg}`);
    positionals.push(arg);
  }
  const command = positionals.shift() ?? (options.help ? 'help' : 'menu');
  return { command, positionals, options };
}

function makeContext({ command, positionals, options }, io, ui) {
  const env = io.env ?? process.env;
  const profile = options.profile ?? 'desktop';
  const layout = resolveLayout({ home: options.home, profile, env, platform: io.platform });
  const retention = options.retention === undefined ? undefined : Number(options.retention);
  const asarPaths = collectAsarPaths({ options, layout, env, platform: io.platform });
  const detector = io.detector ?? (() => isDshRunning({ env, platform: io.platform }));
  const instances = summarizeInstances(detector().names);
  let runtimeVersion = options.runtime ?? io.runtimeVersion ?? null;
  let runtimeSource = runtimeVersion ? 'flag' : null;
  if (!runtimeVersion) {
    const detected = detectRuntime({ layout, env, platform: io.platform, force: false, asarPaths });
    runtimeVersion = detected.version;
    runtimeSource = detected.source;
  }
  return {
    command,
    positionals,
    options,
    ui,
    io,
    env,
    layout,
    profile,
    asarPaths,
    instances,
    retention: Number.isFinite(retention) ? retention : undefined,
    json: Boolean(options.json),
    detector,
    runtimeVersion,
    runtimeSource,
  };
}

/**
 * Archives worth reading: the one the user pointed at, the usual install
 * locations, and any DSH NEXT install referenced by the overlays it left in the
 * profile. Deduplicated, order preserved.
 */
function collectAsarPaths({ options, layout, env, platform }) {
  const candidates = [];
  if (options.asar) candidates.push(options.asar);
  candidates.push(...asarCandidates({ env, platform }));
  candidates.push(...asarFromProfileOverlays(layout.profileDir));
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate || seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

async function confirm(question, ctx) {
  if (ctx.options.yes) return true;
  const stdin = ctx.io.stdin ?? process.stdin;
  if (!stdin.isTTY) return false;
  const stdout = ctx.io.stdout ?? process.stdout;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^(y|yes|是)$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

function printFindings(ui, findings, { limit = 40 } = {}) {
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
  for (const finding of sorted.slice(0, limit)) {
    ui.line(`  ${ui.mark(finding.level)} ${ui.dim(finding.code)}  ${finding.message}`);
    if (finding.hint) ui.line(`      ${ui.dim(`→ ${finding.hint}`)}`);
  }
  if (sorted.length > limit) ui.line(`  ${ui.dim(`… 还有 ${sorted.length - limit} 条`)}`);
}

function doctorFor(ctx, { withKnownIds = true } = {}) {
  const base = {
    layout: ctx.layout,
    runtimeVersion: ctx.runtimeVersion,
    asarPaths: ctx.asarPaths,
    instances: ctx.instances,
  };
  const first = runDoctor(base);
  if (!withKnownIds) return first;
  const collected = collectKnownIds({
    profileDir: ctx.layout.profileDir,
    bundleNames: first.summary.bundlesList,
    asarPaths: ctx.asarPaths,
  });
  if (collected.ids.size === 0) return first;
  return runDoctor({ ...base, state: first.state, knownIds: collected });
}

async function cmdHelp(ctx) {
  ctx.ui.line(USAGE);
  return { code: 0, data: { usage: USAGE } };
}

async function cmdStatus(ctx) {
  const { ui } = ctx;
  const doctor = doctorFor(ctx);
  const crash = latestCrash(ctx.layout.crashDirs);
  const good = getGood(ctx.layout);
  let diff = null;
  let goodSnapshotId = null;
  if (good) {
    try {
      const snapshot = readSnapshot(ctx.layout, good.snapshotId);
      goodSnapshotId = snapshot.id;
      diff = diffStates(snapshot, doctor.state);
    } catch {
      diff = null;
    }
  }

  if (!ctx.json) {
    ui.line(ui.bold(`dsh-rescue ${PACKAGE.version}`));
    ui.line(ui.kv('home', ctx.layout.home));
    ui.line(ui.kv('profile', `${ctx.layout.profile}  ${ui.dim(ctx.layout.profileDir)}`));
    ui.line(ui.kv('runtime', ctx.runtimeVersion ? `${ctx.runtimeVersion} ${ui.dim(`(${sourceLabel(ctx)})`)}` : ui.yellow('未探测到')));
    ui.line(
      ui.kv(
        '规模',
        `${doctor.summary.bundles} 个 bundle / ${doctor.summary.dependencies} 个依赖 / ${doctor.summary.installed} 个已装包` +
          (doctor.summary.patchBytes === null ? '' : ` / patch ${humanBytes(doctor.summary.patchBytes)}`),
      ),
    );
    ui.line('');

    const verdict = doctor.ok
      ? ui.green('体检通过')
      : ui.red(`体检有 ${doctor.errorsCount} 个错误`);
    ui.line(`${verdict}${doctor.warningsCount ? ui.yellow(`，${doctor.warningsCount} 个警告`) : ''}`);
    if (doctor.findings.length > 0) printFindings(ui, doctor.findings);
    ui.line('');

    if (crash) {
      ui.line(`最近崩溃：${formatTime(crash.facts.time ?? new Date(crash.mtimeMs).toISOString())} ${ui.dim(`(${crash.facts.source ?? '?'} · ${path.basename(crash.path)})`)}`);
      const facts = crash.facts;
      if (facts.title) ui.line(`  ${facts.title}`);
      if (facts.exitCode !== null) ui.line(`  宿主退出码 ${facts.exitCode}`);
      for (const name of facts.skippedBundles) ui.line(`  跳过 bundle：${name}`);
      for (const item of facts.incompatible) ui.line(`  ${ui.red('版本不兼容')}：${item.package}@${item.version} 要求 dsh ${item.runtime}`);
      for (const item of facts.pending) ui.line(`  一直等不到服务：${item.entry} (${item.package}) — ${item.reason}`);
    } else {
      ui.line(ui.dim(`最近崩溃：无（找过 ${ctx.layout.crashDirs.length} 个日志目录）`));
    }
    ui.line('');

    if (good) {
      ui.line(`上次可用：${goodSnapshotId ?? good.snapshotId}（${relativeTime(good.at)}）`);
      if (diff && diff.empty) {
        ui.line(`  与当前完全一致 ${ui.green('✓')}`);
      } else if (diff) {
        for (const line of describeDiff(diff)) ui.line(`  ${line}`);
        ui.line(`  ${ui.dim('→ 这些就是"上次好着，后来变了"的东西')}`);
      }
      ui.line('');
    } else {
      ui.line(ui.yellow('还没有标记过可用状态。'));
      ui.line(`  在 DSH 能正常打开的时候跑一次：${ui.cyan('dsh-rescue good')}`);
      ui.line('');
    }

    if (!doctor.ok) {
      ui.line(`${ui.bold('建议下一步')}：修好上面带 × 的问题，或者 ${ui.cyan('dsh-rescue rescue')} 回到上次可用状态。`);
    } else if (diff && !diff.empty) {
      ui.line(`${ui.bold('建议')}：当前能用就先 ${ui.cyan('dsh-rescue good')} 记住它；不对劲就 ${ui.cyan('dsh-rescue rescue')}。`);
    }
  }

  return {
    code: doctor.ok ? 0 : 1,
    data: {
      home: ctx.layout.home,
      profile: ctx.layout.profile,
      runtimeVersion: ctx.runtimeVersion ?? null,
      doctor: {
        ok: doctor.ok,
        errors: doctor.errorsCount,
        warnings: doctor.warningsCount,
        findings: doctor.findings,
      },
      summary: doctor.summary,
      crash: crash ? { path: crash.path, facts: crash.facts } : null,
      good: good ? { id: goodSnapshotId ?? good.snapshotId, at: good.at, diff: diff ? diff : null } : null,
    },
  };
}

function sourceLabel(ctx) {
  if (ctx.runtimeSource === 'flag') return '指定';
  if (ctx.runtimeSource === 'asar') return '安装包';
  if (ctx.runtimeSource === 'cli') return 'cli';
  if (ctx.runtimeSource === 'cache') return '缓存';
  return '未探测';
}

async function cmdDoctor(ctx) {
  const { ui } = ctx;
  const doctor = doctorFor(ctx);
  if (!ctx.json) {
    ui.line(`home ${ctx.layout.home}`);
    ui.line(`profile ${ctx.layout.profile} (${ctx.layout.profileDir})`);
    ui.line(`runtime ${ctx.runtimeVersion ?? '未探测到'}`);
    ui.line('');
    if (doctor.findings.length === 0) {
      ui.line(ui.green('没有发现问题。'));
    } else {
      printFindings(ui, doctor.findings);
    }
    ui.line('');
    ui.line(
      doctor.ok
        ? ui.green(`结论：通过（${doctor.warningsCount} 个警告，${doctor.infosCount} 条信息）`)
        : ui.red(`结论：${doctor.errorsCount} 个错误，${doctor.warningsCount} 个警告`),
    );
  }
  return {
    code: doctor.ok ? 0 : 1,
    data: {
      ok: doctor.ok,
      errors: doctor.errorsCount,
      warnings: doctor.warningsCount,
      infos: doctor.infosCount,
      findings: doctor.findings,
      summary: doctor.summary,
    },
  };
}

async function cmdSave(ctx, kind = 'manual') {
  const { ui } = ctx;
  const doctor = doctorFor(ctx);
  if (kind === 'good' && !doctor.ok && !ctx.options.force) {
    if (!ctx.json) {
      ui.line(ui.red('当前体检不过，拒绝把它标记成"已知可用"。'));
      printFindings(ui, doctor.findings);
      ui.line(`  确实要标记就加 ${ui.cyan('--force')}（不建议：你会把一个坏状态当成退路）。`);
    }
    return { code: 1, data: { ok: false, reason: 'doctor-failed', findings: doctor.findings } };
  }
  const snapshot = createSnapshot({
    home: ctx.layout.home,
    profile: ctx.layout.profile,
    layout: ctx.layout,
    kind,
    label: ctx.options.label ?? '',
    doctor,
    runtimeVersion: ctx.runtimeVersion,
    retention: ctx.retention,
  });
  if (!ctx.json) {
    ui.line(`${kind === 'good' ? ui.green('已标记可用') : '已保存快照'}  ${ui.bold(snapshot.id)}`);
    ui.line(ui.kv('目录', snapshot.dir));
    ui.line(
      ui.kv(
        '内容',
        `${snapshot.meta.bundles ? snapshot.meta.bundles.length : 0} 个 bundle 的启用清单 + ${snapshot.meta.files.filter((file) => file.exists).length} 个配置文件 + ${snapshot.meta.installedCount} 个已装包版本`,
      ),
    );
    if (!doctor.ok) ui.line(ui.yellow(`注意：当前体检有 ${doctor.errorsCount} 个错误，这份快照也会带着它们。`));
  }
  return { code: 0, data: { ok: true, id: snapshot.id, dir: snapshot.dir, kind, meta: snapshot.meta } };
}

async function cmdList(ctx) {
  const { ui } = ctx;
  const snapshots = listSnapshots(ctx.layout);
  const good = getGood(ctx.layout);
  if (!ctx.json) {
    if (snapshots.length === 0) {
      ui.line(`还没有快照。${ui.dim(ctx.layout.snapshotsDir)}`);
    } else {
      ui.line(`${'id'.padEnd(26)} ${'kind'.padEnd(14)} ${'时间'.padEnd(20)} ${'bundle'.padStart(6)}  备注`);
      for (const meta of snapshots) {
        const marker = meta.id === good?.snapshotId ? ui.green('* ') : '  ';
        ui.line(
          `${marker}${String(meta.id).padEnd(24)} ${String(meta.kind).padEnd(14)} ${formatTime(meta.createdAt).padEnd(20)} ` +
            `${String(Array.isArray(meta.bundles) ? meta.bundles.length : '?').padStart(6)}  ${meta.label ?? ''}`,
        );
      }
      ui.line(ui.dim('* = 当前 good 指针'));
    }
  }
  return {
    code: 0,
    data: {
      snapshots: snapshots.map((meta) => ({ ...meta, good: meta.id === good?.snapshotId })),
      good: good?.snapshotId ?? null,
    },
  };
}

async function cmdDiff(ctx) {
  const { ui } = ctx;
  const [aRef = 'good', bRef = 'current'] = ctx.positionals;
  let left;
  let leftLabel;
  try {
    left = readSnapshot(ctx.layout, aRef);
    leftLabel = left.id;
  } catch (error) {
    if (!ctx.json) ui.error(error.message);
    return { code: 1, data: { ok: false, error: error.message } };
  }
  let right;
  let rightLabel;
  if (bRef === 'current') {
    right = captureState({ home: ctx.layout.home, profile: ctx.layout.profile, layout: ctx.layout });
    rightLabel = 'current';
  } else {
    right = readSnapshot(ctx.layout, bRef);
    rightLabel = right.id;
  }
  const diff = diffStates(left, right);
  if (!ctx.json) {
    ui.line(`${leftLabel} → ${rightLabel}`);
    if (diff.empty) {
      ui.line(ui.green('两者完全一致。'));
    } else {
      for (const line of describeDiff(diff)) ui.line(`  ${line}`);
    }
  }
  return { code: 0, data: { ok: true, from: leftLabel, to: rightLabel, diff, lines: describeDiff(diff) } };
}

async function cmdCrash(ctx) {
  const { ui } = ctx;
  const crash = latestCrash(ctx.layout.crashDirs);
  if (!crash) {
    if (!ctx.json) {
      ui.line('没找到崩溃报告。');
      for (const dir of ctx.layout.crashDirs) ui.line(`  ${ui.dim(dir)}`);
    }
    return { code: 0, data: { ok: true, crash: null, dirs: ctx.layout.crashDirs } };
  }
  if (!ctx.json) {
    ui.line(ui.bold(path.basename(crash.path)));
    ui.line(ui.kv('时间', formatTime(crash.facts.time ?? new Date(crash.mtimeMs).toISOString())));
    ui.line(ui.kv('来源', `${crash.facts.source ?? '?'} / ${crash.facts.phase ?? '?'}`));
    ui.line(ui.kv('版本', `${crash.facts.app ?? '?'} · node ${crash.facts.node ?? '?'}`));
    ui.line('');
    if (crash.facts.title) ui.line(`首行错误：${crash.facts.title}`);
    if (crash.facts.exitCode !== null) ui.line(`宿主退出码：${crash.facts.exitCode}`);
    for (const name of crash.facts.skippedBundles) ui.line(`跳过 bundle：${name}`);
    for (const item of crash.facts.incompatible) {
      ui.line(`${ui.red('版本不兼容')}：${item.package}@${item.version} 要求 dsh ${item.runtime}`);
    }
    for (const item of crash.facts.pending) ui.line(`等不到服务：${item.entry} (${item.package}) — ${item.reason}`);
    if (crash.facts.entriesFailed !== null) ui.line(`${crash.facts.entriesFailed} 个 entry 没激活`);
    ui.line('');
    ui.line(ui.dim('完整报告：') + crash.path);
  }
  return { code: 0, data: { ok: true, crash: { path: crash.path, facts: crash.facts } } };
}

function restoreSummary(ctx, result, label) {
  const { ui } = ctx;
  ui.line(`${ui.green('完成')}：已还原到 ${ui.bold(result.snapshotId)}${label ? `（${label}）` : ''}`);
  ui.line(ui.kv('写回', result.written.length === 0 ? '无需改动' : result.written.join(', ')));
  if (result.renamed.length > 0) {
    for (const entry of result.renamed) {
      ui.line(ui.kv('改名留档', `${entry.rel} → ${path.basename(entry.aside)}`));
    }
  }
  ui.line(ui.kv('还原前现场', result.preSnapshotId));
  ui.line(ui.kv('撤回', `dsh-rescue restore ${result.preSnapshotId}`));
}

async function cmdRestore(ctx) {
  const { ui } = ctx;
  const ref = ctx.positionals[0] ?? 'good';
  if (!(await confirm(`要把 profile 还原到快照 ${ref} 吗？`, ctx))) {
    if (!ctx.json) ui.line('已取消（非交互环境请加 --yes）。');
    return { code: 1, data: { ok: false, reason: 'cancelled' } };
  }
  const result = restoreSnapshot({
    layout: ctx.layout,
    ref,
    force: ctx.options.force,
    dryRun: ctx.options.dryRun,
    detector: ctx.detector,
    preKind: 'pre-restore',
    journalAction: 'restore',
    retention: ctx.retention,
  });
  if (ctx.json) return { code: 0, data: { ok: true, ...result } };
  if (ctx.options.dryRun) {
    ui.line(`演练模式：将会写 ${result.plan.filter((item) => item.action === 'write').length} 个文件，` +
      `改名留档 ${result.plan.filter((item) => item.action === 'aside').length} 个。`);
    for (const item of result.plan) ui.line(`  ${item.action === 'write' ? '写' : '改名'} ${item.rel}`);
    return { code: 0, data: { ok: true, ...result } };
  }
  restoreSummary(ctx, result);
  return { code: 0, data: { ok: true, ...result } };
}

async function cmdRescue(ctx) {
  const { ui } = ctx;
  const good = getGood(ctx.layout);
  if (!good) {
    if (!ctx.json) {
      ui.line(ui.red('没有可用状态可以回滚 —— 还没跑过 dsh-rescue good。'));
      ui.line('');
      ui.line('可以这样走：');
      ui.line(`  1. ${ui.cyan('dsh-rescue safe-mode')}   先把第三方插件全关掉，确认 DSH 能起来（可撤回）`);
      ui.line(`  2. ${ui.cyan('dsh-rescue list')}        看有没有早先的快照，挑一个 ${ui.cyan('dsh-rescue restore <id>')}`);
      ui.line(`  3. 起来之后立刻 ${ui.cyan('dsh-rescue good')} 记住这个状态`);
    }
    return { code: 1, data: { ok: false, reason: 'no-good-snapshot' } };
  }

  const broken = captureState({ home: ctx.layout.home, profile: ctx.layout.profile, layout: ctx.layout });
  if (!ctx.json && !ctx.options.dryRun) {
    ui.line(`将回到 ${ui.bold(good.snapshotId)}（${relativeTime(good.at)}标记为可用）`);
  }
  if (!(await confirm('确认还原？会先把当前现场完整存一份。', ctx))) {
    if (!ctx.json) ui.line('已取消（非交互环境请加 --yes）。');
    return { code: 1, data: { ok: false, reason: 'cancelled' } };
  }

  const result = restoreSnapshot({
    layout: ctx.layout,
    ref: good.snapshotId,
    force: ctx.options.force,
    dryRun: ctx.options.dryRun,
    detector: ctx.detector,
    preKind: 'pre-rescue',
    preLabel: '救援前的现场',
    journalAction: 'rescue',
    retention: ctx.retention,
  });

  if (ctx.options.dryRun) {
    if (!ctx.json) {
      ui.line(`演练模式：会写 ${result.plan.filter((item) => item.action === 'write').length} 个文件。`);
      for (const item of result.plan) ui.line(`  ${item.rel}`);
    }
    return { code: 0, data: { ok: true, dryRun: true, ...result } };
  }

  const goodSnapshot = readSnapshot(ctx.layout, good.snapshotId);
  const brokenDiff = diffStates(goodSnapshot, broken);
  const droppedDshKeys = dshKeyDelta(goodSnapshot, broken);
  const after = captureState({ home: ctx.layout.home, profile: ctx.layout.profile, layout: ctx.layout });
  const verify = diffStates(goodSnapshot, after);

  if (!ctx.json) {
    restoreSummary(ctx, result);
    ui.line('');
    if (!brokenDiff.empty) {
      ui.line(`${ui.bold('相对上次可用状态，坏掉时的现场是这样：')}`);
      for (const line of describeDiff(brokenDiff)) ui.line(`  ${line}`);
      ui.line(`  ${ui.dim('以上差异已被撤销。')}`);
    } else {
      ui.line(ui.yellow('注意：坏掉时的配置和 good 一模一样 —— 出问题的可能不是配置，而是包本身或运行环境。'));
      ui.line(`  ${ui.dim('试 dsh-rescue doctor，或 dsh-rescue restore <更早的快照>。')}`);
    }
    if (droppedDshKeys.length > 0) {
      ui.line('');
      ui.line(
        ui.yellow(
          `注意：这次还原会把 package.json 里的 ${droppedDshKeys.map((key) => `dsh.${key}`).join('、')} 去掉 —— ` +
            '这是 DSH NEXT 自己写进去的。NEXT 下次启动通常会补回来，但 bundle 顺序可能变。',
        ),
      );
    }
    ui.line('');
    ui.line(verify.empty ? ui.green('校验：当前配置与 good 逐字节一致 ✓') : ui.yellow('校验：与 good 仍有差异（可能有文件被正在运行的程序改写）'));
  }

  return {
    code: 0,
    data: {
      ok: true,
      snapshotId: result.snapshotId,
      preSnapshotId: result.preSnapshotId,
      written: result.written,
      renamed: result.renamed,
      reversed: describeDiff(brokenDiff),
      verified: verify.empty,
      droppedDshKeys,
    },
  };
}

/** `dsh` sub-keys the current profile has and the snapshot does not. */
function dshKeyDelta(snapshot, current) {
  const keysOf = (state) => {
    const file = (state.files ?? []).find((entry) => entry.key === 'profilePackage');
    if (!file || !file.exists || typeof file.text !== 'string') return null;
    try {
      const raw = JSON.parse(file.text);
      return raw && raw.dsh && typeof raw.dsh === 'object' ? Object.keys(raw.dsh) : [];
    } catch {
      return null;
    }
  };
  const snapshotKeys = keysOf(snapshot);
  const currentKeys = keysOf(current);
  if (!snapshotKeys || !currentKeys) return [];
  return currentKeys.filter((key) => !snapshotKeys.includes(key));
}

async function cmdSafeMode(ctx) {
  const { ui } = ctx;
  if (!(await confirm('进入安全模式：只保留出厂 bundle，第三方插件全部不加载？', ctx))) {
    if (!ctx.json) ui.line('已取消（非交互环境请加 --yes）。');
    return { code: 1, data: { ok: false, reason: 'cancelled' } };
  }
  const result = safeMode({
    layout: ctx.layout,
    force: ctx.options.force,
    dryRun: ctx.options.dryRun,
    detector: ctx.detector,
    retention: ctx.retention,
  });
  if (ctx.json) return { code: 0, data: { ok: true, ...result } };
  if (result.alreadySafe) {
    ui.line('已经是安全模式了（bundles 里只剩出厂项）。');
    return { code: 0, data: { ok: true, ...result } };
  }
  if (ctx.options.dryRun) {
    ui.line(`演练模式：会停用 ${result.droppedBundles.length} 个第三方 bundle，保留 ${result.keptBundles.join(', ')}。`);
    return { code: 0, data: { ok: true, ...result } };
  }
  ui.line(`${ui.green('已进入安全模式')}：保留 ${result.keptBundles.join(', ')}`);
  ui.line(ui.kv('停用', `${result.droppedBundles.length} 个第三方 bundle`));
  for (const name of result.droppedBundles) ui.line(`  - ${name}`);
  ui.line(ui.kv('还原前现场', result.preSnapshotId));
  ui.line('');
  ui.line(`确认能起来之后：${ui.cyan('dsh-rescue undo')} 一次性撤回，或用 ${ui.cyan('dsh-rescue restore ' + result.preSnapshotId)}。`);
  return { code: 0, data: { ok: true, ...result } };
}

async function cmdUndo(ctx) {
  const { ui } = ctx;
  if (!(await confirm('撤回上一次写操作？', ctx))) {
    if (!ctx.json) ui.line('已取消（非交互环境请加 --yes）。');
    return { code: 1, data: { ok: false, reason: 'cancelled' } };
  }
  const result = undoLast({
    layout: ctx.layout,
    force: ctx.options.force,
    dryRun: ctx.options.dryRun,
    detector: ctx.detector,
    retention: ctx.retention,
  });
  if (ctx.json) return { code: 0, data: { ok: true, ...result } };
  ui.line(`${ui.green('已撤回')} ${result.undone.action}（${formatTime(result.undone.at)}）`);
  ui.line(ui.kv('写回', result.written.length === 0 ? '无需改动' : result.written.join(', ')));
  ui.line(ui.kv('还原前现场', result.preSnapshotId));
  return { code: 0, data: { ok: true, ...result } };
}

function failureText(reason) {
  if (reason === 'timeout') return '一直没就绪（多半是某个插件卡在 apply() 里）';
  if (reason === 'exited') return '自己退出了';
  if (reason === 'launch-failed') return '没能启动';
  return reason;
}

/**
 * Watchdog boot: the only thing that can rescue a hang, because a hung host
 * never shows a window or a dialog.
 */
async function cmdLaunch(ctx) {
  const { ui } = ctx;
  const app = resolveAppExecutable({
    app: ctx.options.app,
    env: ctx.env,
    platform: ctx.io.platform,
    asarPaths: ctx.asarPaths,
  });

  const alreadyRunning = ctx.instances.main + ctx.instances.next > 0;

  const seconds = ctx.options.bootTimeout === undefined ? DEFAULT_BOOT_TIMEOUT_MS / 1000 : Number(ctx.options.bootTimeout);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError('--boot-timeout 需要一个正整数（秒）');
  const bootTimeoutMs = Math.round(seconds * 1000);

  const doctor = doctorFor(ctx);
  const good = getGood(ctx.layout);
  const autoRestore = !ctx.options.noAutoRestore;
  const restoreTarget = autoRestore && good ? good.snapshotId : null;

  if (!ctx.json) {
    ui.line(`可执行文件 ${app.path}`);
    ui.line(ui.kv('看门狗', `${seconds} 秒内没就绪就杀掉重来（最多 2 次）`));
    ui.line(
      ui.kv('回滚目标', restoreTarget ? `${restoreTarget}（${relativeTime(good.at)}）` : ui.yellow('没有 good 快照 —— 出问题只能杀，不能救')),
    );
    if (alreadyRunning) {
      ui.line(ui.kv('注意', `现在有实例在跑（主应用 ${ctx.instances.main} / NEXT ${ctx.instances.next}），真启动会被拒绝`));
    }
    if (!doctor.ok) {
      ui.line(ui.yellow(`启动前体检有 ${doctor.errorsCount} 个错误：`));
      printFindings(ui, doctor.findings.filter((finding) => finding.level !== 'info'));
    }
    ui.line('');
  }

  if (ctx.options.dryRun) {
    if (!ctx.json) ui.line('演练模式：不会真的启动。');
    return {
      code: 0,
      data: { ok: true, dryRun: true, executable: app.path, bootTimeoutMs, restoreTarget, alreadyRunning },
    };
  }

  if (alreadyRunning) {
    if (!ctx.json) {
      ui.line(ui.yellow('已经有一个 DSH 在运行，不再启动第二个。'));
      ui.line(`  ${ui.dim('看门狗只对"从零启动"有意义。要用就先用着，要保护就先把它关掉。')}`);
    }
    return { code: 1, data: { ok: false, reason: 'already-running', instances: ctx.instances } };
  }

  const result = await launchGuarded({
    executable: app.path,
    platform: ctx.io.platform,
    env: ctx.env,
    exec: ctx.io.exec,
    spawnImpl: ctx.io.spawn,
    sleep: ctx.io.sleep,
    now: ctx.io.now,
    probe: ctx.io.probe ? (info) => ctx.io.probe(info) : null,
    bootTimeoutMs,
    onFailure: restoreTarget
      ? async ({ attempt, reason }) => {
          if (!ctx.json) {
            ui.line(ui.yellow(`第 ${attempt} 次启动${failureText(reason)}，已杀掉；正在回滚到 ${restoreTarget}…`));
          }
          const restored = restoreSnapshot({
            layout: ctx.layout,
            ref: restoreTarget,
            force: true,
            detector: () => ({ known: true, names: [] }),
            preKind: 'pre-restore',
            preLabel: `before launch rollback (${reason})`,
            journalAction: 'launch-rollback',
            retention: ctx.retention,
          });
          if (!ctx.json) ui.line(ui.kv('已回滚', `${restored.snapshotId}（现场存于 ${restored.preSnapshotId}）`));
          return { ok: true, snapshotId: restored.snapshotId, preSnapshotId: restored.preSnapshotId };
        }
      : null,
  });

  appendJournal(ctx.layout, {
    action: 'launch',
    snapshotId: restoreTarget,
    preSnapshotId: null,
    written: [],
    launched: result.attempts.map((entry) => ({
      attempt: entry.attempt,
      ok: Boolean(entry.ok),
      reason: entry.reason,
      elapsedMs: entry.elapsedMs,
      killed: Boolean(entry.killed),
      restored: entry.restored && entry.restored.snapshotId ? entry.restored.snapshotId : null,
    })),
  });

  if (!ctx.json) {
    for (const entry of result.attempts) {
      const head = entry.ok ? ui.green('启动成功') : ui.red(`启动失败（${failureText(entry.reason)}）`);
      ui.line(`${head} · 第 ${entry.attempt} 次 · ${(entry.elapsedMs / 1000).toFixed(1)} 秒`);
      if (entry.restored && entry.restored.snapshotId) ui.line(`  ${ui.dim(`已回滚到 ${entry.restored.snapshotId}`)}`);
    }
    ui.line('');
    if (result.ok) {
      ui.line(`DSH 已就绪，这个窗口可以关掉（应用在后台继续跑）。`);
    } else {
      ui.line(ui.red('两次都没起来，停止尝试 —— 再循环下去只会耗时间。'));
      ui.line('');
      ui.line(`${ui.bold('可以这样继续')}：`);
      ui.line(`  1. ${ui.cyan('dsh-rescue crash')}      看最近一次崩溃报告到底说了什么`);
      ui.line(`  2. ${ui.cyan('dsh-rescue doctor')}     静态体检（版本闸门、空 patch、依赖不一致）`);
      ui.line(`  3. ${ui.cyan('dsh-rescue safe-mode')}  只留出厂 bundle，确认能起来再逐个加回来`);
    }
  }

  return {
    code: result.ok ? 0 : 1,
    data: {
      ok: result.ok,
      reason: result.reason,
      executable: app.path,
      attempts: result.attempts,
      restoredTo: restoreTarget,
    },
  };
}

async function cmdMenu(ctx) {
  const { ui } = ctx;
  const items = [
    ['launch', '看门狗启动（超时自动回滚）'],
    ['status', '体检 + 最近崩溃（只读）'],
    ['rescue', '一键回滚到上次可用'],
    ['good', '把当前状态记为可用'],
    ['save', '打一份快照'],
    ['list', '快照列表'],
    ['safe-mode', '进入安全模式（只留出厂 bundle）'],
    ['undo', '撤回上一次写操作'],
    ['crash', '看最近一次崩溃'],
  ];
  ui.line(ui.bold(`dsh-rescue ${PACKAGE.version}`));
  ui.line(`home ${ctx.layout.home}`);
  ui.line('');
  items.forEach(([, label], index) => ui.line(`  ${String(index + 1).padStart(2)}) ${label}`));
  ui.line('   0) 退出');
  ui.line('');

  const stdin = ctx.io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    ui.line(ui.dim('（非交互环境，请直接用子命令，例如 dsh-rescue status）'));
    return { code: 0, data: { ok: true, items: items.map(([name]) => name) } };
  }
  const rl = readline.createInterface({ input: stdin, output: ctx.io.stdout ?? process.stdout });
  const answer = await new Promise((resolve) => rl.question('选择: ', resolve));
  rl.close();
  const index = Number(String(answer).trim());
  if (!Number.isInteger(index) || index < 0 || index > items.length) {
    ui.line('没听懂这个选项。');
    return { code: 2, data: { ok: false, reason: 'bad-choice' } };
  }
  if (index === 0) return { code: 0, data: { ok: true, exit: true } };
  const argv = [items[index - 1][0]];
  if (ctx.options.home) argv.push('--home', ctx.options.home);
  if (ctx.options.profile) argv.push('--profile', ctx.options.profile);
  const parsed = parseArgs(argv);
  const sub = makeContext(parsed, ctx.io, ctx.ui);
  const result = await runCommand(parsed.command, sub);
  return { code: result.code, data: result.data };
}

async function runCommand(command, ctx) {
  switch (command) {
    case 'help':
    case '--help':
      return cmdHelp(ctx);
    case 'status':
      return cmdStatus(ctx);
    case 'doctor':
    case 'check':
      return cmdDoctor(ctx);
    case 'save':
    case 'snapshot':
      return cmdSave(ctx, 'manual');
    case 'good':
      return cmdSave(ctx, 'good');
    case 'list':
    case 'ls':
      return cmdList(ctx);
    case 'diff':
      return cmdDiff(ctx);
    case 'crash':
      return cmdCrash(ctx);
    case 'restore':
      return cmdRestore(ctx);
    case 'rescue':
    case 'rollback':
      return cmdRescue(ctx);
    case 'launch':
    case 'boot':
      return cmdLaunch(ctx);
    case 'safe-mode':
      return cmdSafeMode(ctx);
    case 'undo':
      return cmdUndo(ctx);
    case 'menu':
      return cmdMenu(ctx);
    default:
      throw new UsageError(`未知命令 "${command}"。跑 dsh-rescue help 看用法。`);
  }
}

export async function runCli(argv = [], io = {}) {
  const ui = createUi({
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env,
  });

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    ui.error(error.message);
    return 2;
  }
  if (parsed.options.version) {
    ui.line(PACKAGE.version);
    return 0;
  }
  if (parsed.options.help) {
    ui.line(USAGE);
    return 0;
  }

  const ctx = makeContext(parsed, io, ui);
  try {
    const result = await runCommand(parsed.command, ctx);
    if (ctx.json) {
      ui.line(JSON.stringify({ ok: result.code === 0, command: parsed.command, ...result.data }, null, 2));
    }
    return result.code;
  } catch (error) {
    if (error instanceof DshRunningError) {
      ui.error(ui.red(error.message));
      return 1;
    }
    if (error instanceof UsageError) {
      ui.error(error.message);
      return 2;
    }
    if (ctx.json) {
      ui.line(JSON.stringify({ ok: false, command: parsed.command, error: error.message }, null, 2));
    } else {
      ui.error(ui.red(`出错了：${error.message}`));
      if (process.env.DSH_RESCUE_DEBUG === '1' && error.stack) ui.error(error.stack);
    }
    return 1;
  }
}