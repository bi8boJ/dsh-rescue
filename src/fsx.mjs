import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function exists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

export function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Read UTF-8 text; returns `null` for a missing file and rethrows anything else. */
export function readText(target) {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

/** Write through a temp sibling + rename so a crash never leaves half a JSON file. */
export function writeAtomic(target, data) {
  ensureDir(path.dirname(target));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** Move a file aside instead of deleting it. Returns the new path. */
export function moveAside(target, suffix) {
  const aside = `${target}.${suffix}`;
  fs.renameSync(target, aside);
  return aside;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function randomSuffix(bytes = 2) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Compact, lexicographically sortable UTC stamp: 20261029T154438123Z */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '').replace(/(\d{8}T\d{6})(\d{3})Z/, '$1$2Z');
}

/** Filesystem-safe variant for `.pre-<stamp>` suffixes. */
export function fileStamp(date = new Date()) {
  return stamp(date).replace('T', '-');
}

export function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

export function readJson(target) {
  const text = readText(target);
  if (text === null) return null;
  return JSON.parse(text);
}

export function writeJson(target, value) {
  writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}