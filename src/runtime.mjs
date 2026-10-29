import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { readAsarEntry } from './asar.mjs';
import { asarCandidates, MANIFEST_PREFIXES, resourcesDirs } from './installation.mjs';
import { readRuntimeCache, writeRuntimeCache } from './state.mjs';

const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const CACHE_TTL_MS = 60 * 60 * 1000;
/** `getDshRuntimeVersion()` reads this manifest, so we read the same one. */
export const RUNTIME_MANIFEST = 'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json';

export { asarCandidates };

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
  if (!asarPath) return null;
  for (const prefix of MANIFEST_PREFIXES) {
    const buffer = readAsarEntry(asarPath, `${prefix}node_modules/@deepseek-ai/dsh-app-boot/package.json`);
    if (!buffer) continue;
    try {
      const manifest = JSON.parse(buffer.toString('utf8'));
      if (typeof manifest.version === 'string' && VERSION_RE.test(manifest.version)) return manifest.version;
    } catch {
      /* try the next prefix */
    }
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
 * Read from an installed `app.asar` first: no subprocess, and it is the same
 * manifest `getDshRuntimeVersion()` reads. Extra archives (DSH NEXT) can be
 * passed in. The CLI is only a fallback. Cached for an hour, because detection
 * is only needed for diagnostics and an app upgrade within the hour merely
 * shows up as a stale gate result.
 */
export function detectRuntime({
  layout,
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  force = false,
  now = Date.now(),
  asarPath = null,
  asarPaths = null,
} = {}) {
  const cached = layout ? readRuntimeCache(layout) : null;
  if (!force && cached && cached.version && typeof cached.detectedAt === 'number') {
    if (now - cached.detectedAt < CACHE_TTL_MS) {
      return { ...cached, source: 'cache' };
    }
  }

  const candidates = asarPaths ?? (asarPath ? [asarPath] : asarCandidates({ env, platform }));
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