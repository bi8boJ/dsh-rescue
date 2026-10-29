import fs from 'node:fs';
import path from 'node:path';

import { absoluteFor, resolveLayout } from './paths.mjs';
import { readText, sha256, writeJson } from './fsx.mjs';

export class ProfileJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileJsonError';
  }
}

/** Parse a profile `package.json` without trusting any of its fields. */
export function parseProfile(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProfileJsonError(`profile package.json 不是合法 JSON：${error.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProfileJsonError('profile package.json 的顶层必须是 JSON 对象');
  }
  const bundlesRaw = raw.dsh && raw.dsh.profile ? raw.dsh.profile.bundles : undefined;
  const bundles = Array.isArray(bundlesRaw)
    ? bundlesRaw.filter((entry) => typeof entry === 'string')
    : [];
  const dependencies =
    raw.dependencies && typeof raw.dependencies === 'object' && !Array.isArray(raw.dependencies)
      ? raw.dependencies
      : {};
  return { raw, bundles, bundlesRaw: bundlesRaw === undefined ? null : bundlesRaw, dependencies };
}

function readInstalledPackage(packageDir, dirName, out) {
  const manifestPath = path.join(packageDir, 'package.json');
  const text = readText(manifestPath);
  if (text === null) {
    out.push({ name: dirName, version: null, broken: true });
    return;
  }
  try {
    const manifest = JSON.parse(text);
    out.push({
      name: typeof manifest.name === 'string' ? manifest.name : dirName,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      broken: false,
    });
  } catch {
    out.push({ name: dirName, version: null, broken: true });
  }
}

/** Every package physically present in the profile's node_modules, hoisted layout aware. */
export function scanInstalled(profileDir) {
  const nodeModules = path.join(profileDir, 'node_modules');
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(nodeModules, entry.name);
    let stats;
    try {
      stats = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      let scoped;
      try {
        scoped = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of scoped) {
        if (sub.name.startsWith('.')) continue;
        const subFull = path.join(full, sub.name);
        let subStats;
        try {
          subStats = fs.statSync(subFull);
        } catch {
          continue;
        }
        if (!subStats.isDirectory()) continue;
        readInstalledPackage(subFull, `${entry.name}/${sub.name}`, out);
      }
      continue;
    }
    readInstalledPackage(full, entry.name, out);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function installedMap(installed) {
  const map = new Map();
  for (const entry of installed ?? []) if (entry.name) map.set(entry.name, entry.version ?? null);
  return map;
}

/**
 * Read every file that describes the enabled-plugin state.
 * Unreadable files are reported per file instead of aborting the capture, so a
 * permission problem cannot stop a rescue.
 */
export function captureState({ home, profile = 'desktop', layout } = {}) {
  const resolved = layout ?? resolveLayout({ home, profile });
  const files = resolved.stateFiles.map((spec) => {
    const absolute = absoluteFor(resolved.home, spec.rel);
    let text = null;
    let error = null;
    try {
      text = readText(absolute);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    return {
      key: spec.key,
      rel: spec.rel,
      required: Boolean(spec.required),
      exists: text !== null,
      readable: error === null,
      error,
      text,
      sha256: text === null ? null : sha256(text),
      bytes: text === null ? 0 : Buffer.byteLength(text, 'utf8'),
    };
  });
  return {
    home: resolved.home,
    profile: resolved.profile,
    createdAt: new Date().toISOString(),
    files,
    installed: scanInstalled(resolved.profileDir),
  };
}

export function fileByKey(state, key) {
  return state.files.find((file) => file.key === key) ?? null;
}

export function isProfileHealthyJson(state) {
  const file = fileByKey(state, 'profilePackage');
  if (!file || !file.exists) return false;
  try {
    parseProfile(file.text);
    return true;
  } catch {
    return false;
  }
}

/** Cache of the detected DSH runtime version, kept beside the snapshots. */
export function readRuntimeCache(layout) {
  const text = readText(layout.runtimeCacheFile);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function writeRuntimeCache(layout, value) {
  try {
    writeJson(layout.runtimeCacheFile, value);
  } catch {
    // A cache write failure must never break a diagnostic run.
  }
}