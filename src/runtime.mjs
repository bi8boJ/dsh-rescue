import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { readRuntimeCache, writeRuntimeCache } from './state.mjs';

const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Best-effort locations of the `dsh` CLI that ships with the desktop app. */
export function dshCliCandidates({ env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (env.DSH_CLI) candidates.push(env.DSH_CLI);
  if (platform === 'win32') {
    const appData = env.LOCALAPPDATA;
    if (appData) {
      candidates.push(
        path.join(appData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      );
    }
    if (env.ProgramFiles) {
      candidates.push(
        path.join(env.ProgramFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      );
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
  }
  return candidates;
}

function runVersion(cli, spawn) {
  try {
    const result = spawn(cli, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      shell: false,
    });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const match = VERSION_RE.exec(text);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * The version DSH's compatibility gate compares against.
 * Cached for an hour: re-spawning the CLI on every status call is slow, and an
 * app upgrade within the hour only shows up as a stale gate result.
 */
export function detectRuntime({
  layout,
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  force = false,
  now = Date.now(),
} = {}) {
  const cached = layout ? readRuntimeCache(layout) : null;
  if (!force && cached && cached.version && typeof cached.detectedAt === 'number') {
    if (now - cached.detectedAt < CACHE_TTL_MS) {
      return { ...cached, source: 'cache' };
    }
  }
  for (const cli of dshCliCandidates({ env, platform })) {
    const version = runVersion(cli, spawn);
    if (version) {
      const value = { version, cli, detectedAt: now, source: 'cli' };
      if (layout) writeRuntimeCache(layout, value);
      return value;
    }
  }
  return { version: null, cli: null, detectedAt: now, source: 'none' };
}