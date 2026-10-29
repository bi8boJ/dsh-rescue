import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readAsarJson } from './asar.mjs';
import { readRuntimeCache, writeRuntimeCache } from './state.mjs';

const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const CACHE_TTL_MS = 60 * 60 * 1000;
/** `getDshRuntimeVersion()` reads exactly this manifest, so we read the same one. */
export const RUNTIME_MANIFEST = 'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json';

function resourcesDirs({ env = process.env, platform = process.platform } = {}) {
  const dirs = [];
  if (env.DSH_CLI) {
    let dir = path.dirname(env.DSH_CLI);
    for (let depth = 0; depth < 6; depth += 1) {
      if (fs.existsSync(path.join(dir, 'app.asar'))) {
        dirs.push(dir);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources'));
    if (env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, 'DeepSeek Harness', 'resources'));
    if (env['ProgramFiles(x86)']) dirs.push(path.join(env['ProgramFiles(x86)'], 'DeepSeek Harness', 'resources'));
  } else if (platform === 'darwin') {
    dirs.push('/Applications/DeepSeek Harness.app/Contents/Resources');
  } else {
    dirs.push('/opt/DeepSeek Harness/resources', '/usr/lib/deepseek-harness/resources');
  }
  return dirs;
}

/** app.asar paths worth trying, in order. */
export function asarCandidates({ env = process.env, platform = process.platform } = {}) {
  return resourcesDirs({ env, platform }).map((dir) => path.join(dir, 'app.asar'));
}

export function dshCliCandidates({ env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (env.DSH_CLI) candidates.push(env.DSH_CLI);
  if (platform === 'win32') {
    for (const dir of resourcesDirs({ env, platform })) {
      if (!dir.endsWith('resources')) continue;
      candidates.push(path.join(dir, 'runtime', 'cli', 'bin', 'dsh.cmd'));
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
  }
  return candidates;
}

export function versionFromAsar(asarPath) {
  const manifest = readAsarJson(asarPath, RUNTIME_MANIFEST);
  if (manifest && typeof manifest.version === 'string' && VERSION_RE.test(manifest.version)) {
    return manifest.version;
  }
  return null;
}

function runVersion(cli, spawn) {
  try {
    const options = { encoding: 'utf8', timeout: 8000, windowsHide: true };
    const isBatch = /\.(cmd|bat)$/i.test(cli);
    // A `.cmd` cannot be spawned directly on Windows; go through cmd.exe and let
    // /s strip exactly one layer of quotes.
    const result = isBatch
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${cli}" --version"`], {
          ...options,
          windowsVerbatimArguments: true,
        })
      : spawn(cli, ['--version'], options);
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const match = VERSION_RE.exec(text);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * The version DSH's compatibility gate compares against.
 *
 * Read from the installed `app.asar` first: no subprocess, and it is the same
 * manifest `getDshRuntimeVersion()` reads. The CLI is only a fallback. Cached for
 * an hour, because detection is only needed for diagnostics and an app upgrade
 * within the hour merely shows up as a stale gate result.
 */
export function detectRuntime({
  layout,
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  force = false,
  now = Date.now(),
  asarPath = null,
} = {}) {
  const cached = layout ? readRuntimeCache(layout) : null;
  if (!force && cached && cached.version && typeof cached.detectedAt === 'number') {
    if (now - cached.detectedAt < CACHE_TTL_MS) {
      return { ...cached, source: 'cache' };
    }
  }

  const candidates = asarPath ? [asarPath] : asarCandidates({ env, platform });
  for (const candidate of candidates) {
    const version = versionFromAsar(candidate);
    if (version) {
      const value = { version, asar: candidate, cli: null, detectedAt: now, source: 'asar' };
      if (layout) writeRuntimeCache(layout, value);
      return value;
    }
  }

  for (const cli of dshCliCandidates({ env, platform })) {
    const version = runVersion(cli, spawn);
    if (version) {
      const value = { version, cli, asar: null, detectedAt: now, source: 'cli' };
      if (layout) writeRuntimeCache(layout, value);
      return value;
    }
  }

  return { version: null, cli: null, asar: null, detectedAt: now, source: 'none' };
}