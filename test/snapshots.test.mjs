import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveLayout } from '../src/paths.mjs';
import { captureState } from '../src/state.mjs';
import {
  appendJournal,
  createSnapshot,
  getGood,
  listSnapshots,
  newSnapshotId,
  pruneSnapshots,
  readJournal,
  readSnapshot,
  resolveRef,
  setGood,
} from '../src/snapshots.mjs';
import { DEFAULT_PATCH, makeHome, readJsonFile, removeDir } from './helpers/fixture.mjs';

function dateAt(minute) {
  return new Date(Date.UTC(2026, 9, 29, 10, minute, 0, 0));
}

test('createSnapshot 保存配置文件、清单与元数据', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });

  const snapshot = createSnapshot({ layout, kind: 'manual', label: '第一次' });
  assert.match(snapshot.id, /^\d{8}T\d{6}\d{3}Z-[0-9a-f]{4}$/);
  assert.equal(snapshot.meta.kind, 'manual');
  assert.equal(snapshot.meta.label, '第一次');
  assert.deepEqual(snapshot.meta.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-fake-plugin']);

  const stored = fs.readFileSync(path.join(snapshot.dir, 'files', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
  assert.equal(stored, DEFAULT_PATCH);
  assert.ok(fs.existsSync(path.join(snapshot.dir, 'installed.json')));

  const back = readSnapshot(layout, snapshot.id);
  assert.equal(back.files.find((file) => file.key === 'profilePatch').text, DEFAULT_PATCH);
  assert.equal(back.files.find((file) => file.key === 'homePatch').exists, false);
});

test('listSnapshots 按 id 倒序（新的在前）', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  const older = createSnapshot({ layout, now: dateAt(1) });
  const newer = createSnapshot({ layout, now: dateAt(2) });
  const list = listSnapshots(layout);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, newer.id);
  assert.equal(list[1].id, older.id);
});

test('good 指针能写能读，resolveRef 支持 good/last/前缀', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  const first = createSnapshot({ layout, kind: 'good', now: dateAt(1) });
  const second = createSnapshot({ layout, kind: 'manual', now: dateAt(2) });

  assert.equal(getGood(layout).snapshotId, first.id);
  assert.equal(resolveRef(layout, 'good'), first.id);
  assert.equal(resolveRef(layout, 'last'), second.id);
  assert.equal(resolveRef(layout, first.id), first.id);
  assert.equal(resolveRef(layout, first.id.slice(0, 17)), first.id);
});

test('resolveRef 对歧义前缀与不存在的 ref 给明确错误', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  createSnapshot({ layout, now: dateAt(1) });
  createSnapshot({ layout, now: dateAt(1) });
  const prefix = '20261029T1001';
  assert.throws(() => resolveRef(layout, prefix), /匹配到 2 个/);
  assert.throws(() => resolveRef(layout, '29990101'), /找不到快照/);
  assert.throws(() => resolveRef(layout, 'good'), /还没有标记过/);
});

test('没有快照时 resolveRef 提示先 save', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  assert.throws(() => resolveRef(layout, 'last'), /还没有任何快照/);
});

test('pruneSnapshots 只删非 good 的超额快照，永不删 good', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  const good = createSnapshot({ layout, kind: 'good', now: dateAt(1) });
  for (let minute = 2; minute <= 8; minute += 1) {
    createSnapshot({ layout, retention: 100, now: dateAt(minute) });
  }
  assert.equal(listSnapshots(layout).length, 8);
  const removed = pruneSnapshots(layout, 3);
  assert.equal(removed, 4);
  const left = listSnapshots(layout).map((meta) => meta.id);
  assert.ok(left.includes(good.id), 'good 快照不能被回收');
  assert.equal(left.length, 4);
});

test('journal 追加后能读回，最多保留 50 条', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  for (let index = 0; index < 60; index += 1) appendJournal(layout, { action: 'test', n: index });
  const entries = readJournal(layout);
  assert.equal(entries.length, 50);
  assert.equal(entries[entries.length - 1].n, 59);
  assert.ok(entries[0].at);
});

test('setGood 直接写指针（用于手工修正）', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  const snapshot = createSnapshot({ layout, now: dateAt(3) });
  setGood(layout, snapshot.id);
  assert.equal(readJsonFile(path.join(layout.rescueDir, 'good.json')).snapshotId, snapshot.id);
  assert.equal(getGood(layout).snapshotId, snapshot.id);
});

test('newSnapshotId 可排序且带随机后缀', () => {
  const a = newSnapshotId(dateAt(1));
  const b = newSnapshotId(dateAt(2));
  assert.ok(a < b);
  assert.notEqual(a, newSnapshotId(dateAt(1)));
});

test('快照里的文件被删掉时 readSnapshot 明确标记 missingOnDisk', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  const snapshot = createSnapshot({ layout, now: dateAt(1) });
  fs.rmSync(path.join(snapshot.dir, 'files', 'profiles', 'desktop', 'package.json'));
  const back = readSnapshot(layout, snapshot.id);
  const pkg = back.files.find((file) => file.key === 'profilePackage');
  assert.equal(pkg.missingOnDisk, true);
});

test('captureState 与快照的 sha256 一致', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  const live = captureState({ home: home.home, profile: 'desktop', layout });
  const snapshot = createSnapshot({ layout, state: live, now: dateAt(1) });
  const livePkg = live.files.find((file) => file.key === 'profilePackage').sha256;
  assert.equal(snapshot.meta.files.find((file) => file.key === 'profilePackage').sha256, livePkg);
});