import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DshRunningError, restoreSnapshot, safeMode, undoLast } from '../src/restore.mjs';
import { createSnapshot, getGood, readJournal, readSnapshot } from '../src/snapshots.mjs';
import { resolveLayout } from '../src/paths.mjs';
import { captureState } from '../src/state.mjs';
import { DEFAULT_PATCH, SHIPPED_BUNDLES, makeHome, readJsonFile, readFileOrNull, removeDir } from './helpers/fixture.mjs';

const NOT_RUNNING = () => ({ known: true, names: [] });
const RUNNING = () => ({ known: true, names: ['DeepSeek Harness.exe'] });
const UNKNOWN = () => ({ known: false, names: [] });

function setup(options = {}) {
  const home = makeHome(options);
  return { home, layout: resolveLayout({ home: home.home }) };
}

test('还原把 5 个文件恢复到快照里的字节', (t) => {
  const { home, layout } = setup({ compat: { 'dsh-fake-plugin@1.0.0': ['0.2.1-rc.3'] } });
  t.after(() => removeDir(home.home));

  const originalPackage = readFileOrNull(home.packageFile);
  const snapshot = createSnapshot({ layout, kind: 'good' });

  fs.writeFileSync(home.packageFile, `${JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`);
  fs.writeFileSync(home.patchFile, '[]\n');
  fs.writeFileSync(path.join(home.profileDir, 'compatibility.json'), '{}\n');

  const result = restoreSnapshot({ layout, ref: snapshot.id, detector: NOT_RUNNING });
  assert.equal(result.snapshotId, snapshot.id);
  assert.deepEqual([...result.written].sort(), [
    'profiles/desktop/compatibility.json',
    'profiles/desktop/cordis.patch.yml',
    'profiles/desktop/package.json',
  ]);
  assert.equal(readFileOrNull(home.packageFile), originalPackage);
  assert.equal(readFileOrNull(home.patchFile), DEFAULT_PATCH);
  assert.ok(result.preSnapshotId, '写之前必须留下现场快照');
});

test('快照里不存在的文件在还原时改名留档，而不是删掉', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));

  const snapshot = createSnapshot({ layout, kind: 'good' });
  const compatFile = path.join(home.profileDir, 'compatibility.json');
  fs.writeFileSync(compatFile, '{"later":"added"}\n');

  const result = restoreSnapshot({ layout, ref: snapshot.id, detector: NOT_RUNNING });
  assert.equal(fs.existsSync(compatFile), false);
  assert.ok(result.renamed.some((entry) => entry.rel.endsWith('compatibility.json')));
  const aside = fs.readdirSync(home.profileDir).filter((name) => name.startsWith('compatibility.json.pre-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(home.profileDir, aside[0]), 'utf8'), '{"later":"added"}\n');
});

test('DSH 在跑时拒绝写；--force 可以越过', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));
  const snapshot = createSnapshot({ layout, kind: 'good' });
  fs.writeFileSync(home.patchFile, '[]\n');

  assert.throws(
    () => restoreSnapshot({ layout, ref: snapshot.id, detector: RUNNING }),
    (error) => error instanceof DshRunningError && /正在运行/.test(error.message),
  );
  assert.equal(readFileOrNull(home.patchFile), '[]\n', '拒绝时一个字节都不能写');

  const forced = restoreSnapshot({ layout, ref: snapshot.id, detector: RUNNING, force: true });
  assert.equal(readFileOrNull(home.patchFile), DEFAULT_PATCH);
  assert.ok(forced.written.length > 0);
});

test('检测不到进程状态时按"没在跑"处理，但仍是已知结果', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));
  const snapshot = createSnapshot({ layout, kind: 'good' });
  fs.writeFileSync(home.patchFile, '[]\n');
  const result = restoreSnapshot({ layout, ref: snapshot.id, detector: UNKNOWN });
  assert.equal(result.running.known, false);
  assert.equal(readFileOrNull(home.patchFile), DEFAULT_PATCH);
});

test('--dry-run 一个字节都不改，也不产生快照', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));
  const snapshot = createSnapshot({ layout, kind: 'good' });
  fs.writeFileSync(home.patchFile, '[]\n');
  const before = readFileOrNull(home.patchFile);

  const result = restoreSnapshot({ layout, ref: snapshot.id, dryRun: true, detector: RUNNING });
  assert.equal(result.dryRun, true);
  assert.equal(result.preSnapshotId, null);
  assert.ok(result.plan.some((item) => item.rel.endsWith('cordis.patch.yml')));
  assert.equal(readFileOrNull(home.patchFile), before);
  assert.equal(listSnapshotsish(layout), 1);
});

function listSnapshotsish(layout) {
  try {
    return fs.readdirSync(layout.snapshotsDir).length;
  } catch {
    return 0;
  }
}

test('拒绝还原自身不完整的快照', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));
  const snapshot = createSnapshot({ layout, kind: 'good' });
  fs.rmSync(path.join(snapshot.dir, 'files', 'profiles', 'desktop', 'package.json'));
  assert.throws(() => restoreSnapshot({ layout, ref: snapshot.id, detector: NOT_RUNNING }), /自身不完整/);
});

test('拒绝还原 package.json 是坏 JSON 的快照', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));
  const snapshot = createSnapshot({ layout, kind: 'good' });
  fs.writeFileSync(path.join(snapshot.dir, 'files', 'profiles', 'desktop', 'package.json'), '{"broken":');
  assert.throws(() => restoreSnapshot({ layout, ref: snapshot.id, detector: NOT_RUNNING }), /不是合法 JSON/);
});

test('还原前的现场快照能再救回来（双向可逆）', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));
  const good = createSnapshot({ layout, kind: 'good' });
  const brokenPackage = `${JSON.stringify({ dependencies: { 'dsh-fake-plugin': '^1.0.0' }, dsh: { profile: { bundles: SHIPPED_BUNDLES } } }, null, 2)}\n`;
  fs.writeFileSync(home.packageFile, brokenPackage);

  const first = restoreSnapshot({ layout, ref: good.id, detector: NOT_RUNNING });
  assert.equal(readFileOrNull(home.packageFile).includes('dsh-fake-plugin'), true);

  restoreSnapshot({ layout, ref: first.preSnapshotId, detector: NOT_RUNNING });
  assert.equal(readFileOrNull(home.packageFile), brokenPackage);
});

test('safe-mode 只留出厂 bundle，依赖清单不动，undo 能撤回', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));
  const originalBundles = readJsonFile(home.packageFile).dsh.profile.bundles;
  const originalDeps = readJsonFile(home.packageFile).dependencies;

  const result = safeMode({ layout, detector: NOT_RUNNING });
  assert.deepEqual(result.keptBundles, SHIPPED_BUNDLES);
  assert.deepEqual(result.droppedBundles, ['dsh-fake-plugin']);

  const after = readJsonFile(home.packageFile);
  assert.deepEqual(after.dsh.profile.bundles, SHIPPED_BUNDLES);
  assert.deepEqual(after.dependencies, originalDeps, 'dependencies 不能动，否则重装都没法做');
  assert.ok(result.preSnapshotId);

  const undone = undoLast({ layout, detector: NOT_RUNNING });
  assert.equal(undone.undone.action, 'safe-mode');
  assert.deepEqual(readJsonFile(home.packageFile).dsh.profile.bundles, originalBundles);
});

test('safe-mode 保留 dsh 下的其他字段', (t) => {
  const { home, layout } = setup({ dshExtra: { desktopNextScheduleBundle: 2 } });
  t.after(() => removeDir(home.home));
  safeMode({ layout, detector: NOT_RUNNING });
  const after = readJsonFile(home.packageFile);
  assert.equal(after.dsh.desktopNextScheduleBundle, 2);
});

test('已经是安全模式时 safe-mode 是空操作', (t) => {
  const { home, layout } = setup({ bundles: [...SHIPPED_BUNDLES] });
  t.after(() => removeDir(home.home));
  const result = safeMode({ layout, detector: NOT_RUNNING });
  assert.equal(result.alreadySafe, true);
  assert.equal(result.preSnapshotId, null);
});

test('safe-mode 在没有出厂 bundle 时拒绝动手', (t) => {
  const { home, layout } = setup({ bundles: ['dsh-only-plugin'] });
  t.after(() => removeDir(home.home));
  assert.throws(() => safeMode({ layout, detector: NOT_RUNNING }), /不敢动/);
});

test('undo 在没有可撤回记录时给明确错误', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));
  assert.throws(() => undoLast({ layout, detector: NOT_RUNNING }), /没有可撤回的操作/);
});

test('每次写操作都会进 journal', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));
  const snapshot = createSnapshot({ layout, kind: 'good' });
  restoreSnapshot({ layout, ref: snapshot.id, detector: NOT_RUNNING });
  const entries = readJournal(layout);
  const last = entries[entries.length - 1];
  assert.equal(last.action, 'restore');
  assert.equal(last.snapshotId, snapshot.id);
  assert.ok(last.preSnapshotId);
});

test('还原到 good 之后 captureState 的哈希与快照一致', (t) => {
  const { home, layout } = setup();
  t.after(() => removeDir(home.home));
  const good = createSnapshot({ layout, kind: 'good' });
  fs.writeFileSync(home.patchFile, '[]\n');
  restoreSnapshot({ layout, ref: good.id, detector: NOT_RUNNING });
  const stored = readSnapshot(layout, good.id);
  const live = captureState({ home: home.home, profile: 'desktop', layout });
  for (const file of stored.files) {
    const match = live.files.find((entry) => entry.key === file.key);
    assert.equal(match.sha256, file.sha256, `${file.rel} 哈希不一致`);
  }
  assert.equal(getGood(layout).snapshotId, good.id);
});