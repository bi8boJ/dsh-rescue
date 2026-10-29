import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

import { runLaunchWatchdog } from './bootwatch.mjs';
import { isAppReady } from './netprobe.mjs';

export const DEFAULT_BOOT_TIMEOUT_MS = 90_000;
export const DEFAULT_INTERVAL_MS = 1_000;

/**
 * A launched app plus the two things the watchdog needs from it: whether it is
 * still alive, and how to get rid of its whole process tree.
 */
export function makeLauncher({
  executable,
  spawnImpl = spawn,
  exec = execFileSync,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (!executable) throw new Error('makeLauncher: executable is required');
  return ({ attempt } = {}) => {
    const child = spawnImpl(executable, [], {
      stdio: 'ignore',
      detached: false,
      windowsHide: false,
      env,
    });
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    child.once('error', () => {
      exited = true;
    });
    return {
      pid: child.pid,
      attempt,
      raw: child,
      exited: () => exited,
      kill() {
        if (exited) return;
        if (platform === 'win32') {
          // Electron spawns a host child; killing only our PID would leave it behind.
          exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          return;
        }
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      },
    };
  };
}

export function makeProbe({ executable, platform = process.platform, exec } = {}) {
  const exeName = path.basename(String(executable ?? ''));
  return () => {
    try {
      return isAppReady({ exeName, platform, ...(exec ? { exec } : {}) });
    } catch {
      return false;
    }
  };
}

/**
 * Run one protected boot. Returns the watchdog result; side effects (killing,
 * restoring) are wired in by the caller so this stays testable.
 */
export async function launchGuarded({
  executable,
  probe = null,
  spawnImpl = spawn,
  exec = execFileSync,
  platform = process.platform,
  env = process.env,
  bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxAttempts = 2,
  onFailure = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const launch = makeLauncher({ executable, spawnImpl, exec, platform, env });
  const probeReady = probe ?? makeProbe({ executable, platform, exec });
  const children = [];
  const wrappedLaunch = (info) => {
    const child = launch(info);
    children.push(child);
    return child;
  };
  const isExited = ({ pid }) => {
    const child = children.find((entry) => entry.pid === pid);
    return child ? child.exited() : false;
  };

  const result = await runLaunchWatchdog({
    launch: wrappedLaunch,
    probeReady: (info) => probeReady(info),
    isExited,
    sleep,
    now,
    bootTimeoutMs,
    intervalMs,
    maxAttempts,
    onFailure,
    log,
  });

  const last = children[children.length - 1];
  if (result.ok && last && last.raw && typeof last.raw.unref === 'function') {
    // Leave the app running after this process exits.
    try {
      last.raw.unref();
    } catch {
      /* not fatal */
    }
  }
  return { ...result, children };
}