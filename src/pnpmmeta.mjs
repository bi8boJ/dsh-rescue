import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * pnpm records where its content-addressable store lived when node_modules was
 * built. Move the profile to another drive (or roll such a move back) without
 * reinstalling and every `pnpm` command refuses to run:
 *
 *   ERR_PNPM_UNEXPECTED_STORE / ERR_PNPM_UNEXPECTED_VIRTUAL_STORE
 *
 * The app still boots, so the only symptom is that plugin installs break —
 * easy to miss until you actually try to install something. These helpers let
 * `doctor` say it out loud.
 */

export function normalizeForCompare(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length === 0) return '';
  let text = value.replace(/[\\/]+/g, path.sep);
  if (platform === 'win32') {
    text = text.toLowerCase();
    // Windows accepts both drives; strip a trailing separator but keep the root.
    if (text.length > 3 && text.endsWith(path.sep)) text = text.slice(0, -1);
    return text;
  }
  if (text.length > 1 && text.endsWith(path.sep)) text = text.slice(0, -1);
  return text;
}

export function defaultStoreRoot({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    return path.join(localAppData, 'pnpm', 'store');
  }
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'pnpm', 'store');
  const dataHome = env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
  return path.join(dataHome, 'pnpm', 'store');
}

export function pnpmConfigPath({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    return path.join(localAppData, 'pnpm', 'config', 'config.yaml');
  }
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'pnpm', 'config', 'rc');
  return path.join(homeDir, '.config', 'pnpm', 'rc');
}

/** pnpm honours `storeDir` in its own config file; trust that when present. */
export function readConfiguredStoreDir(options = {}) {
  const file = pnpmConfigPath(options);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = /^\s*store[-_]?dir\s*:\s*(.+?)\s*$/im.exec(text);
  if (!match) return null;
  return match[1].replace(/^["']|["']$/g, '');
}

/**
 * Expected store root: explicit flag > pnpm config > platform default.
 * `pnpm store` keeps a `v<N>` child per lockfile format, so compare the roots.
 */
export function resolveExpectedStore(options = {}) {
  const explicit = options.storeDir;
  if (explicit) return { root: explicit, source: 'flag' };
  const configured = readConfiguredStoreDir(options);
  if (configured) return { root: configured, source: 'config' };
  return { root: defaultStoreRoot(options), source: 'default' };
}

export function readModulesMeta(profileDir) {
  const file = path.join(profileDir, 'node_modules', '.modules.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, exists: false, meta: null, error: null };
  }
  try {
    return { file, exists: true, meta: JSON.parse(text), error: null };
  } catch (error) {
    return { file, exists: true, meta: null, error: String(error.message ?? error) };
  }
}

function isUnder(child, parent, platform) {
  const a = normalizeForCompare(child, platform);
  const b = normalizeForCompare(parent, platform);
  if (!a || !b) return false;
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * @returns {{ findings: object[], meta: object|null, expected: object }}
 */
export function checkPnpmStore({ profileDir, platform = process.platform, env = process.env, homeDir = os.homedir(), storeDir = null } = {}) {
  const findings = [];
  const add = (level, code, message, hint) => findings.push({ level, code, message, ...(hint ? { hint } : {}) });
  const nodeModules = path.join(profileDir, 'node_modules');
  const expected = resolveExpectedStore({ platform, env, homeDir, storeDir });

  const { exists: hasNodeModules } = { exists: (() => { try { return fs.statSync(nodeModules).isDirectory(); } catch { return false; } })() };
  const read = readModulesMeta(profileDir);
  if (!read.exists) {
    if (hasNodeModules) {
      add(
        'info',
        'store.meta.missing',
        'node_modules 里没有 .modules.yaml —— 这不是 pnpm 正常装出来的树',
        '插件仍能加载，但 pnpm 可能拒绝操作；需要时用 dsh plugin 重装一次',
      );
    }
    return { findings, meta: null, expected };
  }
  if (read.error) {
    add('warn', 'store.meta.unreadable', `.modules.yaml 不是合法 JSON：${read.error}`, '它记录着 store 位置，坏了 pnpm 会拒绝干活');
    return { findings, meta: null, expected };
  }

  const meta = read.meta ?? {};

  const recordedStore = typeof meta.storeDir === 'string' ? meta.storeDir : null;
  if (recordedStore && !isUnder(recordedStore, expected.root, platform)) {
    add(
      'error',
      'store.mismatch',
      `pnpm 记着依赖来自 ${recordedStore}，而当前 store 是 ${expected.root}`,
      '现在任何 dsh plugin add/update 都会报 ERR_PNPM_UNEXPECTED_STORE。改 .modules.yaml 里的 storeDir（或按文档重装 node_modules）即可',
    );
  }

  const recordedVirtual = typeof meta.virtualStoreDir === 'string' ? meta.virtualStoreDir : null;
  const expectedVirtual = path.join(nodeModules, '.pnpm');
  if (recordedVirtual && normalizeForCompare(recordedVirtual, platform) !== normalizeForCompare(expectedVirtual, platform)) {
    add(
      'error',
      'store.virtualMismatch',
      `pnpm 记着虚拟 store 在 ${recordedVirtual}，而它现在应该在这里：${expectedVirtual}`,
      '同一个 fix：把 virtualStoreDir 指回当前 profile 下的 .pnpm',
    );
  }

  if (!recordedStore && !recordedVirtual) {
    add('info', 'store.meta.incomplete', '.modules.yaml 里没有 storeDir / virtualStoreDir，pnpm 会按默认值重新判断');
  }

  return { findings, meta, expected };
}