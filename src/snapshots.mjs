import fs from 'node:fs';
import path from 'node:path';

import { absoluteFor, resolveLayout } from './paths.mjs';
import { captureState, parseProfile } from './state.mjs';
import { ensureDir, randomSuffix, readJson, readText, rmrf, sha256, stamp, writeAtomic, writeJson } from './fsx.mjs';

const SNAPSHOT_FILE = 'snapshot.json';
const INSTALLED_FILE = 'installed.json';
const FILES_DIR = 'files';
const GOOD_FILE = 'good.json';
const JOURNAL_FILE = 'journal.json';

export const DEFAULT_RETENTION = 30;
export const SNAPSHOT_KINDS = Object.freeze([
  'manual',
  'good',
  'pre-restore',
  'pre-rescue',
  'pre-safe-mode',
  'pre-undo',
]);

export function newSnapshotId(date = new Date()) {
  return `${stamp(date)}-${randomSuffix(2)}`;
}

function bundlesOf(state) {
  const file = state.files.find((entry) => entry.key === 'profilePackage');
  if (!file || !file.exists) return null;
  try {
    return parseProfile(file.text).bundles;
  } catch {
    return null;
  }
}

/**
 * Persist one state snapshot. Config files only — never node_modules.
 */
export function createSnapshot({
  home,
  profile = 'desktop',
  kind = 'manual',
  label = '',
  doctor = null,
  state = null,
  runtimeVersion = null,
  retention = DEFAULT_RETENTION,
  now = new Date(),
  layout,
} = {}) {
  const resolved = layout ?? resolveLayout({ home, profile });
  const captured = state ?? captureState({ home: resolved.home, profile: resolved.profile, layout: resolved });
  const id = newSnapshotId(now);
  const dir = path.join(resolved.snapshotsDir, id);
  ensureDir(dir);

  for (const file of captured.files) {
    if (!file.exists || typeof file.text !== 'string') continue;
    writeAtomic(absoluteFor(path.join(dir, FILES_DIR), file.rel), file.text);
  }
  writeJson(path.join(dir, INSTALLED_FILE), captured.installed ?? []);

  const meta = {
    version: 1,
    id,
    kind,
    label: String(label ?? ''),
    createdAt: captured.createdAt ?? now.toISOString(),
    home: resolved.home,
    profile: resolved.profile,
    runtimeVersion: runtimeVersion ?? null,
    bundles: bundlesOf(captured),
    files: captured.files.map((file) => ({
      key: file.key,
      rel: file.rel,
      required: Boolean(file.required),
      exists: Boolean(file.exists),
      sha256: file.sha256 ?? null,
      bytes: file.bytes ?? 0,
    })),
    installedCount: (captured.installed ?? []).length,
    doctor: doctor ? { ok: Boolean(doctor.ok), errors: doctor.errorsCount ?? 0, warnings: doctor.warningsCount ?? 0 } : null,
  };
  writeJson(path.join(dir, SNAPSHOT_FILE), meta);

  if (kind === 'good') setGood(resolved, id);
  pruneSnapshots(resolved, retention);
  return { id, dir, meta };
}

export function listSnapshots(layout) {
  let names;
  try {
    names = fs.readdirSync(layout.snapshotsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(layout.snapshotsDir, entry.name, SNAPSHOT_FILE);
    const meta = readJson(metaPath);
    if (!meta || typeof meta !== 'object') continue;
    metas.push({ ...meta, id: meta.id ?? entry.name });
  }
  return metas.sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

export function getGood(layout) {
  const value = readJson(path.join(layout.rescueDir, GOOD_FILE));
  if (!value || typeof value.snapshotId !== 'string') return null;
  return value;
}

export function setGood(layout, snapshotId, now = new Date()) {
  writeJson(path.join(layout.rescueDir, GOOD_FILE), {
    snapshotId,
    at: now.toISOString(),
  });
}

export function resolveRef(layout, ref = 'last') {
  const list = listSnapshots(layout);
  if (list.length === 0) {
    throw new Error(`还没有任何快照（${layout.snapshotsDir} 为空）。先跑 dsh-rescue save。`);
  }
  if (ref === undefined || ref === null || ref === '' || ref === 'last') return list[0].id;
  if (ref === 'good') {
    const good = getGood(layout);
    if (!good) throw new Error('还没有标记过"已知可用"状态。健康时跑一次 dsh-rescue good。');
    if (!list.some((meta) => meta.id === good.snapshotId)) {
      throw new Error(`good 指针指向 ${good.snapshotId}，但快照目录里找不到它（被删了？）`);
    }
    return good.snapshotId;
  }
  if (list.some((meta) => meta.id === ref)) return ref;
  const matches = list.filter((meta) => String(meta.id).startsWith(String(ref)));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`快照前缀 "${ref}" 匹配到 ${matches.length} 个：${matches.map((meta) => meta.id).join(', ')}`);
  }
  throw new Error(`找不到快照 "${ref}"。用 dsh-rescue list 看有哪些。`);
}

export function readSnapshot(layout, ref = 'last') {
  const id = resolveRef(layout, ref);
  const dir = path.join(layout.snapshotsDir, id);
  const meta = readJson(path.join(dir, SNAPSHOT_FILE));
  if (!meta) throw new Error(`快照 ${id} 缺少 snapshot.json，目录可能被手动删过`);
  const installed = readJson(path.join(dir, INSTALLED_FILE)) ?? [];
  const files = (meta.files ?? []).map((entry) => {
    if (!entry.exists) {
      return { ...entry, exists: false, text: null, missingOnDisk: false };
    }
    const text = readText(absoluteFor(path.join(dir, FILES_DIR), entry.rel));
    return {
      ...entry,
      exists: text !== null,
      text,
      sha256: text === null ? null : sha256(text),
      missingOnDisk: text === null,
    };
  });
  return { id, dir, meta, installed, files };
}

export function pruneSnapshots(layout, retention = DEFAULT_RETENTION) {
  const keep = Number.isFinite(retention) ? Math.max(1, Math.floor(retention)) : DEFAULT_RETENTION;
  const list = listSnapshots(layout);
  const good = getGood(layout);
  const protectedIds = new Set([good?.snapshotId].filter(Boolean));
  const removable = list.filter((meta) => !protectedIds.has(meta.id));
  const excess = removable.slice(keep);
  for (const meta of excess) rmrf(path.join(layout.snapshotsDir, meta.id));
  return excess.length;
}

export function readJournal(layout) {
  const value = readJson(path.join(layout.rescueDir, JOURNAL_FILE));
  if (!value || !Array.isArray(value.entries)) return [];
  return value.entries;
}

export function appendJournal(layout, entry) {
  const entries = readJournal(layout);
  entries.push({ at: new Date().toISOString(), ...entry });
  const trimmed = entries.slice(-50);
  writeJson(path.join(layout.rescueDir, JOURNAL_FILE), { version: 1, entries: trimmed });
  return trimmed;
}