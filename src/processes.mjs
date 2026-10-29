import { execFileSync } from 'node:child_process';

const WINDOWS_NAMES = [/^DeepSeek Harness\.exe$/i, /^DSH NEXT\.exe$/i];
const POSIX_PATTERN = /DeepSeek Harness|DSH NEXT|dsh-desktop-host|dsh\/lib\/index\.js/i;

/**
 * Is a DSH app running right now?
 *
 * Writing the profile while it runs is dangerous: `dsh-hmr` picks the change up
 * and applies it to the live process, so a rescue could break the session that
 * is still healthy. Detection is best effort; `known: false` means "could not
 * tell", and the caller decides whether that is acceptable.
 */
export function isDshRunning({ platform = process.platform, env = process.env, exec = execFileSync, detector } = {}) {
  if (typeof detector === 'function') return detector();
  if (env.DSH_RESCUE_ASSUME_RUNNING === '1') {
    return { known: true, names: ['(DSH_RESCUE_ASSUME_RUNNING=1)'] };
  }
  if (env.DSH_RESCUE_ASSUME_RUNNING === '0') {
    return { known: true, names: [] };
  }
  try {
    if (platform === 'win32') {
      const output = exec('tasklist', ['/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      const names = new Set();
      for (const line of String(output).split(/\r?\n/)) {
        const match = /^"([^"]+)"/.exec(line.trim());
        if (!match) continue;
        if (WINDOWS_NAMES.some((pattern) => pattern.test(match[1]))) names.add(match[1]);
      }
      return { known: true, names: [...names] };
    }
    const output = exec('ps', ['-eo', 'comm'], { encoding: 'utf8', timeout: 8000 });
    const names = new Set();
    for (const line of String(output).split(/\r?\n/)) {
      const name = line.trim();
      if (name !== '' && POSIX_PATTERN.test(name)) names.add(name);
    }
    return { known: true, names: [...names] };
  } catch {
    return { known: false, names: [] };
  }
}