import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { bundlesHash, describeBeacon, readBeacon, beaconPath } from '../src/beacon.mjs';
import plugin, { applyBeacon, bundlesHash as pluginHash, readBundles, resolveProfileDir } from '../plugin/lib/index.js';
import { resolveLayout } from '../src/paths.mjs';
import { makeHome, removeDir, tempDir } from './helpers/fixture.mjs';

test('CLI 与插件的 bundlesHash 必须一致（否则信标永远对不上）', () => {
  const samples = [[], ['a'], ['a', 'b'], ['@x/y', 'z']];
  for (const sample of samples) {
    assert.equal(bundlesHash(sample), pluginHash(sample), JSON.stringify(sample));
  }
});

test('bundles 顺序不同 → 哈希不同（顺序会影响装载）', () => {
  assert.notEqual(bundlesHash(['a', 'b']), bundlesHash(['b', 'a']));
});

test('describeBeacon：没有文件时 found=false', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  assert.deepEqual(describeBeacon({ layout, bundles: ['a'] }), { found: false });
});

test('describeBeacon：ok + 哈希一致 → 可以 --auto', (t) => {
  const home = makeHome({ bundles: ['@deepseek-ai/dsh-base', 'alpha'] });
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  const bundles = JSON.parse(fs.readFileSync(home.packageFile, 'utf8')).dsh.profile.bundles;
  fs.mkdirSync(layout.rescueDir, { recursive: true });
  fs.writeFileSync(
    beaconPath(layout),
    JSON.stringify({
      version: 1,
      state: 'ok',
      bundlesHash: bundlesHash(bundles),
      bundlesCount: bundles.length,
      startedAt: '2026-10-29T10:00:00.000Z',
      readyAt: '2026-10-29T10:01:00.000Z',
      delayMs: 60000,
    }),
  );
  const described = describeBeacon({ layout, bundles, now: Date.parse('2026-10-29T10:02:00.000Z') });
  assert.equal(described.found, true);
  assert.equal(described.state, 'ok');
  assert.equal(described.hashMatches, true);
  assert.equal(described.ageMs, 60000);
});

test('describeBeacon：booting 或哈希不一致都不算数', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  fs.mkdirSync(layout.rescueDir, { recursive: true });
  fs.writeFileSync(beaconPath(layout), JSON.stringify({ state: 'booting', bundlesHash: bundlesHash(['a']) }));
  const booting = describeBeacon({ layout, bundles: ['a'] });
  assert.equal(booting.state, 'booting');
  assert.equal(booting.hashMatches, true);

  const changed = describeBeacon({ layout, bundles: ['a', 'b'] });
  assert.equal(changed.hashMatches, false);
});

test('坏掉的 beacon.json 不会抛异常', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const layout = resolveLayout({ home: home.home });
  fs.mkdirSync(layout.rescueDir, { recursive: true });
  fs.writeFileSync(beaconPath(layout), '{ broken');
  assert.equal(readBeacon(layout), null);
  assert.equal(describeBeacon({ layout, bundles: [] }).found, false);
});

test('插件：applyBeacon 写出的内容能被 CLI 正确解读', (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const target = path.join(root, 'beacon.json');
  const profileDir = path.join(root, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'alpha'] } } }),
  );

  applyBeacon({ profileDir, state: 'ok', startedAt: 'a', readyAt: 'b', target });
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(written.state, 'ok');
  assert.equal(written.bundlesHash, bundlesHash(['@deepseek-ai/dsh-base', 'alpha']));
  assert.equal(written.bundlesCount, 2);
});

async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('插件：apply 用真实计时器写 beacon，且不抛异常', async (t) => {
  const home = makeHome({ bundles: ['@deepseek-ai/dsh-base', 'alpha'] });
  t.after(() => removeDir(home.home));
  fs.mkdirSync(path.join(home.home, 'rescue'), { recursive: true });
  const target = path.join(home.home, 'rescue', 'beacon.json');
  const previousCwd = process.cwd();

  await withEnv({ DSH_HOME: home.home, DSH_PROFILE_DIR: undefined }, async () => {
    process.chdir(home.profileDir);
    try {
      let dispose = null;
      const root = {
        effect(fn) {
          dispose = fn();
        },
      };
      plugin.apply(root, { delayMs: 20 });
      const booting = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.equal(booting.state, 'booting');
      assert.equal(booting.bundlesCount, 2);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const ok = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.equal(ok.state, 'ok');
      assert.ok(ok.readyAt);
      if (typeof dispose === 'function') dispose();
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('插件：找不到 profile 时静默返回，不写文件', (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const empty = path.join(root, 'empty-cwd');
  fs.mkdirSync(empty, { recursive: true });
  const nohome = path.join(root, 'nohome');
  const previousCwd = process.cwd();

  return withEnv({ DSH_HOME: nohome, DSH_PROFILE_DIR: undefined }, () => {
    try {
      process.chdir(empty);
      assert.equal(resolveProfileDir(empty, nohome, {}), null);
      plugin.apply({}, { delayMs: 10 });
      assert.equal(fs.existsSync(path.join(nohome, 'rescue', 'beacon.json')), false);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test('插件：DSH_PROFILE_DIR 优先于 cwd', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  return withEnv({ DSH_PROFILE_DIR: home.profileDir }, () => {
    assert.equal(resolveProfileDir('/definitely/not/a/profile', home.home), home.profileDir);
  });
});

test('插件：readBundles 对坏 JSON 返回空数组而不是抛', (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  assert.deepEqual(readBundles(root), []);
  fs.writeFileSync(path.join(root, 'package.json'), '{nope');
  assert.deepEqual(readBundles(root), []);
});