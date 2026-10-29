import fs from 'node:fs';
import path from 'node:path';

import { absoluteFor, resolveLayout } from './paths.mjs';
import { captureState, parseProfile } from './state.mjs';
import { appendJournal, createSnapshot, readJournal, readSnapshot, resolveRef } from './snapshots.mjs';
import { ensureDir, fileStamp, readText, writeAtomic } from './fsx.mjs';
import { isDshRunning } from './processes.mjs';

export const SHIPPED_MODE_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

export class DshRunningError extends Error {
  constructor(names) {
    const both = names.some((name) => /deepseek harness/i.test(name)) && names.some((name) => /dsh next/i.test(name));
    const extra = both
      ? '（主应用和 DSH NEXT 同时在跑：两个宿主共用同一份 profile，改文件会被两边同时热应用。）'
      : '';
    super(
      `DSH 正在运行（${names.join('、')}）。此刻写 profile 会被 dsh-hmr 当场热应用，` +
        `可能把还好的状态也弄坏${extra}。请先退出 DSH 再执行；确实要强写，加 --force。`,
    );
    this.name = 'DshRunningError';
    this.names = names;
  }
}

function assertWritable({ dryRun, force, detector }) {
  if (dryRun) return { known: true, names: [] };
  const running = isDshRunning({ detector });
  if (running.known && running.names.length > 0 && !force) throw new DshRunningError(running.names);
  return running;
}

function detectIndent(text) {
  const match = /^\{\r?\n([ \t]+)"/.exec(String(text ?? ''));
  return match ? match[1] : '  ';
}

/**
 * Restore every state file from a snapshot.
 *
 * Order of operations matters: the pre-restore snapshot is written first, so a
 * failure halfway still leaves the user with a way back.
 */
export function restoreSnapshot({
  home,
  profile = 'desktop',
  ref = 'good',
  force = false,
  dryRun = false,
  detector,
  layout,
  preKind = 'pre-restore',
  preLabel = '',
  journalAction = 'restore',
  retention,
} = {}) {
  const resolved = layout ?? resolveLayout({ home, profile });
  const running = assertWritable({ dryRun, force, detector });
  const snapshot = readSnapshot(resolved, ref);

  const missing = snapshot.files.filter((file) => file.missingOnDisk);
  if (missing.length > 0) {
    throw new Error(
      `快照 ${snapshot.id} 自身不完整（缺 ${missing.map((file) => file.rel).join('、')}），拒绝用它还原`,
    );
  }

  const packageFile = snapshot.files.find((file) => file.key === 'profilePackage');
  if (packageFile && packageFile.exists) {
    try {
      JSON.parse(packageFile.text);
    } catch (error) {
      throw new Error(`快照 ${snapshot.id} 的 package.json 不是合法 JSON，拒绝还原：${error.message}`);
    }
  }

  const current = captureState({ home: resolved.home, profile: resolved.profile, layout: resolved });
  const plan = [];
  for (const file of snapshot.files) {
    const live = current.files.find((entry) => entry.key === file.key);
    if (file.exists) {
      if (!live || !live.exists || live.text !== file.text) {
        plan.push({ action: 'write', rel: file.rel, bytes: file.bytes });
      }
    } else if (live && live.exists) {
      plan.push({ action: 'aside', rel: file.rel });
    }
  }

  if (dryRun) {
    return { dryRun: true, snapshotId: snapshot.id, preSnapshotId: null, plan, written: [], renamed: [], running };
  }

  const pre = createSnapshot({
    home: resolved.home,
    profile: resolved.profile,
    layout: resolved,
    kind: preKind,
    label: preLabel || `before ${journalAction} ${snapshot.id}`,
    state: current,
    retention,
  });

  const written = [];
  const renamed = [];
  for (const file of snapshot.files) {
    const target = absoluteFor(resolved.home, file.rel);
    const live = current.files.find((entry) => entry.key === file.key);
    if (file.exists) {
      if (live && live.exists && live.text === file.text) continue;
      ensureDir(path.dirname(target));
      writeAtomic(target, file.text);
      written.push(file.rel);
      continue;
    }
    if (live && live.exists) {
      const aside = `${target}.pre-${fileStamp()}`;
      fs.renameSync(target, aside);
      renamed.push({ rel: file.rel, aside });
    }
  }

  appendJournal(resolved, {
    action: journalAction,
    snapshotId: snapshot.id,
    preSnapshotId: pre.id,
    written,
    renamed: renamed.map((entry) => entry.rel),
  });

  return {
    dryRun: false,
    snapshotId: snapshot.id,
    preSnapshotId: pre.id,
    plan,
    written,
    renamed,
    running,
  };
}

/**
 * Keep only the shipped bundles. Everything else is dropped from
 * `dsh.profile.bundles` while `dependencies` stays untouched, so re-enabling is
 * just put the name back (or `dsh-rescue undo`).
 */
export function safeMode({
  home,
  profile = 'desktop',
  force = false,
  dryRun = false,
  detector,
  layout,
  retention,
} = {}) {
  const resolved = layout ?? resolveLayout({ home, profile });
  const running = assertWritable({ dryRun, force, detector });
  const current = captureState({ home: resolved.home, profile: resolved.profile, layout: resolved });
  const packageFile = current.files.find((file) => file.key === 'profilePackage');
  if (!packageFile || !packageFile.exists) {
    throw new Error(`找不到 ${resolved.profileDir}${path.sep}package.json，profile 还没初始化，无法进入安全模式`);
  }
  const parsed = parseProfile(packageFile.text);
  const keptBundles = parsed.bundles.filter((name) => SHIPPED_MODE_BUNDLES.includes(name));
  const droppedBundles = parsed.bundles.filter((name) => !SHIPPED_MODE_BUNDLES.includes(name));
  if (keptBundles.length === 0) {
    throw new Error('bundles 里既没有 @deepseek-ai/dsh-base 也没有 @deepseek-ai/dsh-web-app，不敢动');
  }
  if (droppedBundles.length === 0) {
    return { dryRun, alreadySafe: true, keptBundles, droppedBundles, preSnapshotId: null, written: [] };
  }

  const indent = detectIndent(packageFile.text);
  const next = {
    ...parsed.raw,
    dsh: { ...(parsed.raw.dsh ?? {}), profile: { ...(parsed.raw.dsh?.profile ?? {}), bundles: keptBundles } },
  };
  const text = `${JSON.stringify(next, null, indent)}\n`;
  const target = absoluteFor(resolved.home, packageFile.rel);

  if (dryRun) {
    return { dryRun: true, alreadySafe: false, keptBundles, droppedBundles, preSnapshotId: null, written: [packageFile.rel] };
  }

  const pre = createSnapshot({
    home: resolved.home,
    profile: resolved.profile,
    layout: resolved,
    kind: 'pre-safe-mode',
    label: 'before safe-mode',
    state: current,
    retention,
  });
  writeAtomic(target, text);
  appendJournal(resolved, {
    action: 'safe-mode',
    snapshotId: null,
    preSnapshotId: pre.id,
    written: [packageFile.rel],
    droppedBundles,
  });
  return {
    dryRun: false,
    alreadySafe: false,
    keptBundles,
    droppedBundles,
    preSnapshotId: pre.id,
    written: [packageFile.rel],
  };
}

export function undoLast({ home, profile = 'desktop', force = false, dryRun = false, detector, layout, retention } = {}) {
  const resolved = layout ?? resolveLayout({ home, profile });
  const entries = readJournal(resolved);
  const last = [...entries].reverse().find((entry) => entry.preSnapshotId);
  if (!last) throw new Error('没有可撤回的操作（journal 里没有带前置快照的记录）');
  const restored = restoreSnapshot({
    layout: resolved,
    ref: last.preSnapshotId,
    force,
    dryRun,
    detector,
    preKind: 'pre-undo',
    preLabel: `undo ${last.action} @ ${last.at}`,
    journalAction: 'undo',
    retention,
  });
  return { ...restored, undone: { action: last.action, at: last.at, preSnapshotId: last.preSnapshotId } };
}

export { resolveRef, readText };