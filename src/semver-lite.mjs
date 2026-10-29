/**
 * A deliberately small semver subset: enough for DSH plugin version gates.
 *
 * DSH compares with `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`,
 * so prereleases take part in every comparison and the usual "a prerelease only
 * matches its own tuple" rule does not apply.
 */

const VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parse(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^[v=]\s*/, '');
  const match = VERSION_RE.exec(text);
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].filter((part) => part !== undefined).length;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    pre: match[4] ? match[4].split('.') : null,
    parts,
    raw: value,
  };
}

function asVersion(value) {
  if (value && typeof value === 'object') return value;
  return parse(value);
}

export function compare(left, right) {
  const a = asVersion(left);
  const b = asVersion(right);
  if (!a || !b) throw new Error(`compare: invalid version (${String(left)} / ${String(right)})`);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const WILDCARD_RE = /^[xX*]$/;

function wildcardBounds(raw) {
  const parts = raw.split('.');
  const wildcardAt = parts.findIndex((part) => WILDCARD_RE.test(part));
  if (wildcardAt === -1) return null;
  const fixed = parts.slice(0, wildcardAt).map(Number);
  if (fixed.some((n) => Number.isNaN(n))) return null;
  const lower = { major: fixed[0] ?? 0, minor: fixed[1] ?? 0, patch: fixed[2] ?? 0, pre: null, parts: 3 };
  let upper;
  if (fixed.length === 0) return { always: true };
  if (fixed.length === 1) upper = { major: fixed[0] + 1, minor: 0, patch: 0, pre: null, parts: 3 };
  else upper = { major: fixed[0], minor: fixed[1] + 1, patch: 0, pre: null, parts: 3 };
  return { lower, upper };
}

function caretUpper(target) {
  if (target.major > 0) return { major: target.major + 1, minor: 0, patch: 0, pre: null, parts: 3 };
  if (target.minor > 0) return { major: 0, minor: target.minor + 1, patch: 0, pre: null, parts: 3 };
  return { major: 0, minor: 0, patch: target.patch + 1, pre: null, parts: 3 };
}

function tildeUpper(target) {
  if (target.parts >= 2) return { major: target.major, minor: target.minor + 1, patch: 0, pre: null, parts: 3 };
  return { major: target.major + 1, minor: 0, patch: 0, pre: null, parts: 3 };
}

function satisfiesToken(version, token) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!match) return false;
  const op = match[1] ?? '=';
  const raw = match[2].trim();
  if (raw === '' || WILDCARD_RE.test(raw)) return true;

  const bounds = wildcardBounds(raw);
  if (bounds) {
    if (bounds.always) return true;
    return compare(version, bounds.lower) >= 0 && compare(version, bounds.upper) < 0;
  }

  const target = parse(raw);
  if (!target) return false;

  switch (op) {
    case '>=':
      return compare(version, target) >= 0;
    case '<=':
      return compare(version, target) <= 0;
    case '>':
      return compare(version, target) > 0;
    case '<':
      return compare(version, target) < 0;
    case '=':
      if (target.parts < 3 && target.pre === null) {
        return version.major === target.major && version.minor === target.minor;
      }
      return compare(version, target) === 0;
    case '^':
      return compare(version, target) >= 0 && compare(version, caretUpper(target)) < 0;
    case '~':
      return compare(version, target) >= 0 && compare(version, tildeUpper(target)) < 0;
    default:
      return false;
  }
}

function satisfiesAlternative(version, alternative) {
  const text = alternative.trim();
  if (text === '') return true;
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen) {
    const lower = parse(hyphen[1]);
    const upper = parse(hyphen[2]);
    if (!lower || !upper) return false;
    return compare(version, lower) >= 0 && compare(version, upper) <= 0;
  }
  return text
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => satisfiesToken(version, token));
}

export function satisfies(version, range) {
  const target = asVersion(version);
  if (!target) return false;
  const text = range === undefined || range === null ? '' : String(range).trim();
  if (text === '' || text === '*' || WILDCARD_RE.test(text)) return true;
  return text.split('||').some((alternative) => satisfiesAlternative(target, alternative));
}