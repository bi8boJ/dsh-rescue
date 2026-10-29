import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { describeDiff, diffStates } from '../src/diff.mjs';
import { resolveLayout } from '../src/paths.mjs';
import { captureState } from '../src/state.mjs';
import { SHIPPED_BUNDLES, makeHome, readJsonFile, removeDir } from './helpers/fixture.mjs';

function stateOf(home) {
  return captureState({ home: home.home, profile: 'desktop', layout: resolveLayout({ home: home.home }) });
}

function mutate(home, mutatePackage, patchText) {
  const packageJson = readJsonFile(home.packageFile);
  mutatePackage(packageJson);
  fs.writeFileSync(home.packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  if (patchText !== undefined) fs.writeFileSync(home.patchFile, patchText);
}

test('完全相同的两个状态没有差异', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const diff = diffStates(stateOf(home), stateOf(home));
  assert.equal(diff.empty, true);
  assert.deepEqual(describeDiff(diff), []);
});

test('新增/删除 bundle、依赖版本变化、换序都能认出来', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const before = stateOf(home);

  mutate(home, (packageJson) => {
    packageJson.dsh.profile.bundles = [...SHIPPED_BUNDLES, 'brand-new', 'dsh-fake-plugin'];
    packageJson.dependencies['brand-new'] = '^2.0.0';
    packageJson.dependencies['dsh-fake-plugin'] = '^1.5.0';
  });
  const after = stateOf(home);
  const diff = diffStates(before, after);

  assert.deepEqual(diff.bundles.added, ['brand-new']);
  assert.deepEqual(diff.bundles.removed, []);
  assert.deepEqual(diff.deps.added, [{ name: 'brand-new', spec: '^2.0.0' }]);
  assert.deepEqual(diff.deps.changed, [{ name: 'dsh-fake-plugin', from: '^1.0.0', to: '^1.5.0' }]);
  assert.equal(diff.empty, false);

  const lines = describeDiff(diff);
  assert.ok(lines.some((line) => line.includes('新增 bundle：brand-new')));
  assert.ok(lines.some((line) => line.includes('依赖版本变化：dsh-fake-plugin')));
});

test('同集合换顺序记为 reordered', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const before = stateOf(home);
  mutate(home, (packageJson) => {
    packageJson.dsh.profile.bundles = ['dsh-fake-plugin', ...SHIPPED_BUNDLES];
  });
  const diff = diffStates(before, stateOf(home));
  assert.equal(diff.bundles.reordered, true);
  assert.deepEqual(diff.bundles.added, []);
  assert.deepEqual(diff.bundles.removed, []);
});

test('patch 的增删条目与纯文本改动分别标记', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const before = stateOf(home);

  fs.writeFileSync(home.patchFile, '- id: llm-pi-ai\n- id: extra-row\n');
  const added = diffStates(before, stateOf(home));
  assert.deepEqual(added.patch.addedIds, ['extra-row']);
  assert.deepEqual(added.patch.removedIds, ['compaction-basic']);
  assert.equal(added.patch.textChanged, true);

  const home2 = makeHome();
  t.after(() => removeDir(home2.home));
  const base = stateOf(home2);
  fs.writeFileSync(home2.patchFile, '# 只改注释\n- id: llm-pi-ai\n- id: compaction-basic\n');
  const commentOnly = diffStates(base, stateOf(home2));
  assert.deepEqual(commentOnly.patch.addedIds, []);
  assert.deepEqual(commentOnly.patch.removedIds, []);
  assert.equal(commentOnly.patch.textChanged, true);
});

test('文件出现/消失/内容变化都进 files', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const before = stateOf(home);
  fs.writeFileSync(`${home.profileDir}/compatibility.json`, '{}\n');
  fs.rmSync(home.patchFile);
  const diff = diffStates(before, stateOf(home));
  assert.ok(diff.files.added.some((rel) => rel.endsWith('compatibility.json')));
  assert.ok(diff.files.removed.some((rel) => rel.endsWith('cordis.patch.yml')));
});

test('坏 JSON 不阻止 diff（只是拿不到 bundle 列表）', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const before = stateOf(home);
  fs.writeFileSync(home.packageFile, '{broken');
  const after = stateOf(home);
  const diff = diffStates(before, after);
  assert.deepEqual(diff.bundles.removed.sort(), [...SHIPPED_BUNDLES, 'dsh-fake-plugin'].sort());
  assert.ok(diff.files.changed.some((rel) => rel.endsWith('package.json')));
});