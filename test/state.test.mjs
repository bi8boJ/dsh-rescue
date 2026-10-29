import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ProfileJsonError, captureState, fileByKey, installedMap, parseProfile, scanInstalled } from '../src/state.mjs';
import { makeHome, removeDir, writeManifest } from './helpers/fixture.mjs';

test('captureState 记录全部五个配置文件的存在性', (t) => {
  const home = makeHome({ compat: { 'dsh-fake-plugin@1.0.0': ['0.2.1-rc.3'] } });
  t.after(() => removeDir(home.home));

  const state = captureState({ home: home.home, profile: 'desktop' });
  assert.equal(state.files.length, 5);
  const byKey = Object.fromEntries(state.files.map((file) => [file.key, file]));
  assert.equal(byKey.profilePackage.exists, true);
  assert.equal(byKey.profilePatch.exists, true);
  assert.equal(byKey.profileCompat.exists, true);
  assert.equal(byKey.profileWorkspace.exists, false);
  assert.equal(byKey.homePatch.exists, false);
  assert.equal(byKey.profileWorkspace.text, null);
  assert.equal(byKey.profilePackage.sha256.length, 64);
  assert.ok(byKey.profilePackage.bytes > 0);
});

test('captureState 不会因为缺文件而抛异常', (t) => {
  const home = makeHome({ patch: false, nodeModules: false });
  t.after(() => removeDir(home.home));
  const state = captureState({ home: home.home, profile: 'desktop' });
  const patch = fileByKey(state, 'profilePatch');
  assert.equal(patch.exists, false);
  assert.equal(patch.readable, true);
  assert.equal(patch.error, null);
});

test('installed 覆盖普通包与 @scope/name，跳过 .pnpm 与 .bin', (t) => {
  const home = makeHome({
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-fake-plugin', '@scope/thing'],
  });
  t.after(() => removeDir(home.home));

  fs.mkdirSync(path.join(home.nodeModules, '.pnpm'), { recursive: true });
  fs.mkdirSync(path.join(home.nodeModules, '.bin'), { recursive: true });
  writeManifest(home.profileDir, 'broken-pkg', null);

  const installed = scanInstalled(home.profileDir);
  const names = installed.map((entry) => entry.name);
  assert.ok(names.includes('dsh-fake-plugin'));
  assert.ok(names.includes('@scope/thing'));
  assert.ok(names.includes('broken-pkg'));
  assert.ok(!names.includes('.pnpm'));
  assert.ok(!names.includes('.bin'));
  assert.equal(installed.find((entry) => entry.name === 'broken-pkg').broken, true);

  const map = installedMap(installed);
  assert.equal(map.get('dsh-fake-plugin'), '1.0.0');
});

test('parseProfile 拒绝非法 JSON 与非法顶层', () => {
  assert.throws(() => parseProfile('{oops'), ProfileJsonError);
  assert.throws(() => parseProfile('null'), ProfileJsonError);
  assert.throws(() => parseProfile('[]'), ProfileJsonError);
});

test('parseProfile 过滤非字符串 bundle，缺 dependencies 时给空对象', () => {
  const parsed = parseProfile(
    JSON.stringify({ dependencies: { a: '1.0.0' }, dsh: { profile: { bundles: ['a', 3, null] } } }),
  );
  assert.deepEqual(parsed.bundles, ['a']);
  assert.deepEqual(parsed.dependencies, { a: '1.0.0' });
  assert.deepEqual(parsed.bundlesRaw, ['a', 3, null]);

  const bare = parseProfile('{}');
  assert.deepEqual(bare.bundles, []);
  assert.deepEqual(bare.dependencies, {});
  assert.equal(bare.bundlesRaw, null);
});