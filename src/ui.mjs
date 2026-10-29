export function createUi({ stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const useColor = Boolean(stdout.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';
  const paint = (code) => (value) => (useColor ? `\u001b[${code}m${value}\u001b[0m` : String(value));
  return {
    color: useColor,
    bold: paint('1'),
    dim: paint('2'),
    red: paint('31'),
    green: paint('32'),
    yellow: paint('33'),
    cyan: paint('36'),
    line(text = '') {
      stdout.write(`${text}\n`);
    },
    write(text) {
      stdout.write(String(text));
    },
    error(text) {
      stderr.write(`${text}\n`);
    },
    kv(label, value, width = 8) {
      const pad = ' '.repeat(Math.max(0, width - [...String(label)].length));
      return `${paint('2')(label)}${pad} ${value}`;
    },
    mark(level) {
      if (level === 'error') return paint('31')('×');
      if (level === 'warn') return paint('33')('!');
      return paint('2')('·');
    },
  };
}

export function formatTime(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return '未知时间';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

export function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}