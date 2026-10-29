import { execFileSync } from 'node:child_process';

const LOOPBACK_RE = /^(127\.|::1$|\[::1\]$|localhost$)/i;

function defaultExec(file, args, options) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, ...options });
}

/**
 * Parse `netstat -ano` into `{address, port, pid}` rows for listening TCP sockets.
 * Only IPv4/IPv6 loopback rows matter: DSH binds `127.0.0.1` by design.
 */
export function parseListening(output) {
  const rows = [];
  for (const raw of String(output ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^tcp/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const [proto, local, , state, pidText] = parts;
    if (!/^tcp/i.test(proto)) continue;
    if (!/^LISTEN/i.test(state)) continue;
    const at = local.lastIndexOf(':');
    if (at <= 0) continue;
    const address = local.slice(0, at);
    const port = Number(local.slice(at + 1));
    const pid = Number(pidText);
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
    rows.push({ address, port, pid, loopback: LOOPBACK_RE.test(address) });
  }
  return rows;
}

/** Image name per PID, from `tasklist` (Windows) or `ps` (elsewhere). */
export function parseProcessTable(output, platform = process.platform) {
  const map = new Map();
  if (platform === 'win32') {
    for (const raw of String(output ?? '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith('"')) continue;
      const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
      const name = cells[0];
      const pid = Number(cells[1]);
      if (name && Number.isFinite(pid)) map.set(pid, name);
    }
    return map;
  }
  for (const raw of String(output ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (match) map.set(Number(match[1]), match[2]);
  }
  return map;
}

export function listListening({ exec = defaultExec, platform = process.platform } = {}) {
  try {
    const output =
      platform === 'win32' ? exec('netstat', ['-ano']) : exec('netstat', ['-an']);
    return parseListening(output);
  } catch {
    return [];
  }
}

export function processTable({ exec = defaultExec, platform = process.platform } = {}) {
  try {
    const output =
      platform === 'win32' ? exec('tasklist', ['/NH', '/FO', 'CSV']) : exec('ps', ['-eo', 'pid=,comm=']);
    return parseProcessTable(output, platform);
  } catch {
    return new Map();
  }
}

/**
 * Is any process whose image name matches `exeName` listening on loopback?
 * That is what "DSH actually came up" looks like from the outside: the host
 * binds its web server before it reports ready.
 */
export function isAppReady({ exeName, exec = defaultExec, platform = process.platform } = {}) {
  if (!exeName) return false;
  const listeners = listListening({ exec, platform }).filter((row) => row.loopback);
  if (listeners.length === 0) return false;
  const table = processTable({ exec, platform });
  const wanted = String(exeName).toLowerCase();
  const appPids = new Set(
    [...table.entries()]
      .filter(([, name]) => String(name).toLowerCase() === wanted)
      .map(([pid]) => pid),
  );
  if (appPids.size === 0) return false;
  return listeners.some((row) => appPids.has(row.pid));
}

/** Loopback ports owned by the given image name — handy for diagnostics. */
export function appListeningPorts({ exeName, exec = defaultExec, platform = process.platform } = {}) {
  const listeners = listListening({ exec, platform }).filter((row) => row.loopback);
  const table = processTable({ exec, platform });
  const wanted = String(exeName).toLowerCase();
  const appPids = new Set(
    [...table.entries()]
      .filter(([, name]) => String(name).toLowerCase() === wanted)
      .map(([pid]) => pid),
  );
  return listeners.filter((row) => appPids.has(row.pid)).map((row) => row.port);
}