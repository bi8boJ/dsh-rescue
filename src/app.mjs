import fs from 'node:fs';
import path from 'node:path';

import { asarCandidates } from './runtime.mjs';

function exists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The executable that owns `…/resources/app.asar` sits two levels up
 * (`resources/..`). Both DSH apps follow that layout, and the name differs
 * ("DeepSeek Harness.exe" vs "DSH NEXT.exe"), so read the directory instead of
 * guessing the name.
 */
export function executableBesideAsar(asarPath) {
  const appDir = path.dirname(path.dirname(asarPath));
  let entries;
  try {
    entries = fs.readdirSync(appDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const executables = entries.filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name)).map((entry) => entry.name);
  if (executables.length === 0) return null;
  const preferred = executables.find((name) => /harness|dsh/i.test(name)) ?? executables[0];
  return path.join(appDir, preferred);
}

export function appCandidates({ env = process.env, platform = process.platform, asarPaths = null } = {}) {
  const out = [];
  const push = (candidate) => {
    if (candidate && !out.includes(candidate) && exists(candidate)) out.push(candidate);
  };

  for (const asar of asarPaths ?? asarCandidates({ env, platform })) push(executableBesideAsar(asar));

  if (platform === 'win32') {
    if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));
    if (env.ProgramFiles) push(path.join(env.ProgramFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'));
    if (env['ProgramFiles(x86)']) push(path.join(env['ProgramFiles(x86)'], 'DeepSeek Harness', 'DeepSeek Harness.exe'));
  } else if (platform === 'darwin') {
    push('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness');
  } else {
    push('/opt/DeepSeek Harness/deepseek-harness');
  }
  return out;
}

export function resolveAppExecutable({ app = null, env = process.env, platform = process.platform, asarPaths = null } = {}) {
  if (app) {
    if (!exists(app)) throw new Error(`--app 指向的文件不存在：${app}`);
    return { path: app, source: 'flag' };
  }
  const [first] = appCandidates({ env, platform, asarPaths });
  if (!first) {
    throw new Error('找不到 DSH 可执行文件。用 --app <路径> 指定，例如 --app "C:\\...\\DeepSeek Harness.exe"');
  }
  return { path: first, source: 'detected' };
}

export function exeNameOf(executablePath) {
  // Both separators: the name must survive a Windows path on a POSIX runner.
  return String(executablePath ?? '').split(/[\\/]/).pop();
}