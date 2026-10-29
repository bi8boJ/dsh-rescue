// dsh-rescue-beacon —— 宿主侧的启动信标
//
// 目标只有一个：留下「这一套配置确实起来了，而且活了 N 秒」的证据，让
// `dsh-rescue good --auto` 不用人记着去按，也让 `status` 能说清上次成功启动是什么时候。
//
// 三条硬约束：
//   1. 绝不因为它而影响启动 —— 所有写入都包在 try/catch 里，失败就静默。
//   2. 不碰 profile 配置，只往 <DSH_HOME>/rescue/beacon.json 写一个文件。
//   3. 路径在调用时解析，不在模块加载时固化 —— 否则测试和自定义 DSH_HOME 都会写错地方。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DELAY_MS = 60_000;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function beaconPath() {
  return path.join(dshHome(), 'rescue', 'beacon.json');
}

/** Same algorithm as `src/beacon.mjs` in the CLI; a short hash of the ordered bundle list. */
export function bundlesHash(bundles) {
  return crypto.createHash('sha256').update((bundles ?? []).join('\n')).digest('hex');
}

function looksLikeProfile(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).isFile();
  } catch {
    return false;
  }
}

/**
 * Where the profile is. The host exports `DSH_PROFILE_DIR` (verified on a real
 * desktop install); its `cwd` is the profile directory too. Scanning
 * `<DSH_HOME>/profiles` is the last resort.
 */
export function resolveProfileDir(cwd = process.cwd(), home = dshHome(), env = process.env) {
  const candidates = [env.DSH_PROFILE_DIR, cwd].filter(Boolean);
  for (const dir of candidates) {
    if (looksLikeProfile(dir)) return dir;
  }
  try {
    for (const entry of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(home, 'profiles', entry.name);
      if (looksLikeProfile(dir)) return dir;
    }
  } catch {
    /* no profiles dir */
  }
  return null;
}

export function readBundles(profileDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    const bundles = parsed && parsed.dsh && parsed.dsh.profile ? parsed.dsh.profile.bundles : undefined;
    return Array.isArray(bundles) ? bundles.filter((name) => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

/** Atomic write: a half-written beacon would be worse than none. */
export function writeBeacon(payload, target = beaconPath()) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

export function applyBeacon({
  profileDir,
  state,
  startedAt,
  readyAt = null,
  delayMs = DEFAULT_DELAY_MS,
  pid = process.pid,
  target = beaconPath(),
}) {
  const bundles = readBundles(profileDir);
  const payload = {
    version: 1,
    state,
    pid,
    profileDir,
    bundlesHash: bundlesHash(bundles),
    bundlesCount: bundles.length,
    startedAt,
    readyAt,
    delayMs,
  };
  return writeBeacon(payload, target);
}

export default {
  name: 'rescue-beacon',
  apply(root, config = {}) {
    const delayMs = Number(config && config.delayMs) > 0 ? Number(config.delayMs) : DEFAULT_DELAY_MS;
    const profileDir = resolveProfileDir();
    if (!profileDir) return;
    const startedAt = new Date().toISOString();
    let timer = null;
    try {
      applyBeacon({ profileDir, state: 'booting', startedAt, delayMs });
    } catch {
      /* a beacon must never break a boot */
    }
    try {
      timer = setTimeout(() => {
        try {
          applyBeacon({ profileDir, state: 'ok', startedAt, readyAt: new Date().toISOString(), delayMs });
        } catch {
          /* ignore */
        }
      }, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
    } catch {
      timer = null;
    }
    try {
      root?.effect?.(() => () => {
        if (timer) {
          try {
            clearTimeout(timer);
          } catch {
            /* ignore */
          }
        }
      });
    } catch {
      /* ignore */
    }
  },
};

export const __test = { DEFAULT_DELAY_MS, looksLikeProfile, dshHome };