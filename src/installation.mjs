import fs from 'node:fs';
import path from 'node:path';

import { readAsarEntry, readAsarJson } from './asar.mjs';

/**
 * Inside `app.asar` the DSH runtime sits either under a `dsh/` folder (the
 * desktop package layout) or at the archive root (how DSH NEXT is packaged).
 * Both are real; neither can be assumed.
 */
export const MANIFEST_PREFIXES = Object.freeze(['dsh/', '']);

/** Candidate `resources/` directories for a DSH installation. */
export function resourcesDirs({ env = process.env, platform = process.platform } = {}) {
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

export function asarCandidates({ env = process.env, platform = process.platform } = {}) {
  return resourcesDirs({ env, platform }).map((dir) => path.join(dir, 'app.asar'));
}

/** Read a package manifest that ships inside the app archive. */
export function packageFromAsar(asarPath, name) {
  for (const prefix of MANIFEST_PREFIXES) {
    const entry = `${prefix}node_modules/${name}/package.json`;
    const manifest = readAsarJson(asarPath, entry);
    if (manifest && typeof manifest === 'object') return { manifest, prefix, entry };
  }
  return null;
}

/** Read a package manifest from `<app.asar>.unpacked`, where native deps live. */
export function packageFromUnpacked(asarPath, name) {
  const file = path.join(`${asarPath}.unpacked`, 'node_modules', ...String(name).split('/'), 'package.json');
  try {
    return { manifest: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return null;
  }
}

/**
 * A bundle does not have to be a profile dependency: DSH NEXT injects its own
 * bundles (`dsh-community-market`, the bridge connector) straight from its
 * archive. Resolve those too, otherwise they look like broken installs.
 */
export function resolveAppPackage({ name, asarPaths = [] }) {
  for (const asarPath of asarPaths) {
    const found = packageFromAsar(asarPath, name);
    if (found) return { ...found, origin: 'app', asarPath };
    const unpacked = packageFromUnpacked(asarPath, name);
    if (unpacked) return { ...unpacked, prefix: '', origin: 'app-unpacked', asarPath };
  }
  return null;
}

/** Read a file referenced by an app-provided package (e.g. its bundle patch). */
export function readFromAsar(asarPath, prefix, relativePath) {
  const normalized = String(relativePath).replace(/^[./\\]+/, '').split(path.sep).join('/');
  return readAsarEntry(asarPath, `${prefix}${normalized}`) ?? readAsarEntry(asarPath, normalized);
}

/**
 * DSH NEXT records its own install location inside the overlay files it writes
 * into the profile, e.g.
 *   "connectorSourceDir": "D:\\…\\DSH NEXT\\resources\\app.asar.unpacked\\node_modules\\…"
 * Recover the archive path from there so both apps' bundles can be resolved
 * without the user having to pass anything.
 */
export function asarFromProfileOverlays(profileDir) {
  let entries;
  try {
    entries = fs.readdirSync(profileDir);
  } catch {
    return [];
  }
  const found = new Set();
  for (const name of entries) {
    if (!/^desktop-next\..*\.json$/i.test(name)) continue;
    let value;
    try {
      value = JSON.parse(fs.readFileSync(path.join(profileDir, name), 'utf8'));
    } catch {
      continue;
    }
    for (const text of collectStrings(value)) {
      const match = /^(.*?[\\/]resources)[\\/]app\.asar(?:\.unpacked)?(?:[\\/]|$)/i.exec(text);
      if (match) found.add(path.join(match[1], 'app.asar'));
    }
  }
  return [...found];
}

function collectStrings(value, out = [], depth = 0) {
  if (depth > 8) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out, depth + 1));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, out, depth + 1));
  return out;
}

/** True when the profile shows any sign of being driven by DSH NEXT too. */
export function nextMarkers({ profileDir, packageJson }) {
  const markers = [];
  const dsh = packageJson && packageJson.dsh ? packageJson.dsh : {};
  for (const key of Object.keys(dsh)) {
    if (/^desktopNext/i.test(key)) markers.push(`package.json 里的 dsh.${key}`);
  }
  try {
    for (const name of fs.readdirSync(profileDir)) {
      if (/^desktop-next\..*\.json$/i.test(name)) markers.push(name);
    }
  } catch {
    /* profile missing */
  }
  return markers;
}