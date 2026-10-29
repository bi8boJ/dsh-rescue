import { parseProfile } from './state.mjs';
import { analyzePatch } from './yamlpatch.mjs';

function keyed(state) {
  const map = new Map();
  for (const file of state?.files ?? []) map.set(file.key, file);
  return map;
}

function safeProfile(file) {
  if (!file || !file.exists || typeof file.text !== 'string') return null;
  try {
    return parseProfile(file.text);
  } catch {
    return null;
  }
}

function safePatch(file) {
  if (!file || file.exists !== true || typeof file.text !== 'string') return null;
  return analyzePatch(file.text);
}

/**
 * Structured difference between two captured states.
 * `from` is the older/reference state, `to` the newer one, so `added` means
 * "present in `to`, missing from `from`".
 */
export function diffStates(from, to) {
  const a = keyed(from);
  const b = keyed(to);

  const profileA = safeProfile(a.get('profilePackage'));
  const profileB = safeProfile(b.get('profilePackage'));
  const bundlesA = profileA ? profileA.bundles : [];
  const bundlesB = profileB ? profileB.bundles : [];
  const setA = new Set(bundlesA);
  const setB = new Set(bundlesB);
  const added = bundlesB.filter((name) => !setA.has(name));
  const removed = bundlesA.filter((name) => !setB.has(name));
  const reordered =
    added.length === 0 &&
    removed.length === 0 &&
    bundlesA.length === bundlesB.length &&
    bundlesA.join('\u0000') !== bundlesB.join('\u0000');

  const depsA = profileA ? profileA.dependencies : {};
  const depsB = profileB ? profileB.dependencies : {};
  const depAdded = [];
  const depRemoved = [];
  const depChanged = [];
  for (const [name, spec] of Object.entries(depsB)) {
    if (!Object.hasOwn(depsA, name)) depAdded.push({ name, spec });
    else if (depsA[name] !== spec) depChanged.push({ name, from: depsA[name], to: spec });
  }
  for (const [name, spec] of Object.entries(depsA)) {
    if (!Object.hasOwn(depsB, name)) depRemoved.push({ name, spec });
  }

  const patchA = safePatch(a.get('profilePatch'));
  const patchB = safePatch(b.get('profilePatch'));
  const idsA = new Set(patchA ? patchA.ids : []);
  const idsB = new Set(patchB ? patchB.ids : []);
  const patchAdded = [...idsB].filter((id) => !idsA.has(id));
  const patchRemoved = [...idsA].filter((id) => !idsB.has(id));
  const patchTextChanged = (a.get('profilePatch')?.sha256 ?? null) !== (b.get('profilePatch')?.sha256 ?? null);

  const fileChanged = [];
  const fileAdded = [];
  const fileRemoved = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(key);
    const right = b.get(key);
    if (!left || !right) continue;
    if (!left.exists && right.exists) fileAdded.push(right.rel);
    else if (left.exists && !right.exists) fileRemoved.push(left.rel);
    else if (left.exists && right.exists && left.sha256 !== right.sha256) fileChanged.push(right.rel);
  }

  const empty =
    added.length === 0 &&
    removed.length === 0 &&
    !reordered &&
    depAdded.length === 0 &&
    depRemoved.length === 0 &&
    depChanged.length === 0 &&
    patchAdded.length === 0 &&
    patchRemoved.length === 0 &&
    !patchTextChanged &&
    fileChanged.length === 0 &&
    fileAdded.length === 0 &&
    fileRemoved.length === 0;

  return {
    empty,
    bundles: { added, removed, reordered },
    deps: { added: depAdded, removed: depRemoved, changed: depChanged },
    patch: { addedIds: patchAdded, removedIds: patchRemoved, textChanged: patchTextChanged },
    files: { changed: fileChanged, added: fileAdded, removed: fileRemoved },
  };
}

/** Short human summary lines; empty when nothing changed. */
export function describeDiff(diff) {
  const lines = [];
  for (const name of diff.bundles.added) lines.push(`新增 bundle：${name}`);
  for (const name of diff.bundles.removed) lines.push(`减少 bundle：${name}`);
  if (diff.bundles.reordered) lines.push('bundle 顺序变了');
  for (const entry of diff.deps.added) lines.push(`新增依赖：${entry.name}@${entry.spec}`);
  for (const entry of diff.deps.removed) lines.push(`移除依赖：${entry.name}@${entry.spec}`);
  for (const entry of diff.deps.changed) lines.push(`依赖版本变化：${entry.name} ${entry.from} → ${entry.to}`);
  for (const id of diff.patch.addedIds) lines.push(`patch 新增条目：${id}`);
  for (const id of diff.patch.removedIds) lines.push(`patch 移除条目：${id}`);
  if (diff.patch.textChanged && diff.patch.addedIds.length === 0 && diff.patch.removedIds.length === 0) {
    lines.push('patch 内容有改动（注释或某个条目的配置值）');
  }
  for (const rel of diff.files.changed) lines.push(`文件内容变化：${rel}`);
  for (const rel of diff.files.added) lines.push(`文件出现：${rel}`);
  for (const rel of diff.files.removed) lines.push(`文件消失：${rel}`);
  return lines;
}