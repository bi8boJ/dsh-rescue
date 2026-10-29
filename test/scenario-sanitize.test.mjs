import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { DEFAULT_PATCH, SHIPPED_BUNDLES, makeHome, makeIo, readFileOrNull, readJsonFile, removeDir } from './helpers/fixture.mjs';

async function run(home, argv) {
  const capture = makeIo({ home: home.home });
  const code = await runCli(argv, capture.io);
  return { code, out: capture.stdout(), json: () => capture.json() };
}

/**
 * The rescue that matters: DSH's own native recovery rewrites
 * `dsh.profile.bundles` down to the shipped set and renames the patch file.
 * Nothing keeps a copy of the bundle list. We must put it back byte for byte.
 */
test('模拟 DSH 自带的 sanizeProfile 洗劫后，rescue 逐字节还原', async (t) => {
  const home = makeHome({
    bundles: [...SHIPPED_BUNDLES, 'dsh-fake-plugin', 'dsh-pet'],
    deps: { 'dsh-fake-plugin': '^1.0.0', 'dsh-pet': '^0.3.7' },
    compat: { 'dsh-fake-plugin@1.0.0': ['0.2.1-rc.3'] },
    homePatch: '# 家目录级补丁\n- id: llm-pi-ai\n  disabled: false\n',
  });
  t.after(() => removeDir(home.home));

  const originalPackage = readFileOrNull(home.packageFile);
  const originalHomePatch = readFileOrNull(path.join(home.home, 'cordis.patch.yml'));
  const good = await run(home, ['good', '--json']);
  assert.equal(good.code, 0, good.out);

  // --- 这就是 sanitizeProfile() 干的事 ---
  const backupName = `${home.patchFile}.bak-${Date.now()}`;
  fs.renameSync(home.patchFile, backupName);
  const manifest = readJsonFile(home.packageFile);
  manifest.dsh.profile.bundles = [...SHIPPED_BUNDLES];
  fs.writeFileSync(home.packageFile, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.equal(fs.existsSync(home.patchFile), false);

  const rescued = await run(home, ['rescue', '--yes', '--json']);
  assert.equal(rescued.code, 0, rescued.out);
  const payload = rescued.json();
  assert.equal(payload.verified, true);

  assert.equal(readFileOrNull(home.packageFile), originalPackage, 'bundles 顺序与整个 package.json 都要逐字节回来');
  assert.equal(readFileOrNull(home.patchFile), DEFAULT_PATCH);
  assert.equal(readFileOrNull(path.join(home.home, 'cordis.patch.yml')), originalHomePatch);

  // 我们不该动 DSH 自己留下的备份
  assert.ok(fs.existsSync(backupName), 'DSH 的 .bak 必须留着');

  // 依赖清单没被 DSH 动过，也不该被我们动
  const deps = readJsonFile(home.packageFile).dependencies;
  assert.equal(deps['dsh-pet'], '^0.3.7');
});

test('插件打架（新增了一个 bundle + patch 多了一行）能被 rescue 精确撤销', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const good = await run(home, ['good', '--json']);
  assert.equal(good.code, 0);

  const manifest = readJsonFile(home.packageFile);
  manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles, 'conflicting-plugin'];
  manifest.dependencies['conflicting-plugin'] = '^2.0.0';
  fs.writeFileSync(home.packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(home.patchFile, `${DEFAULT_PATCH}- id: conflicting-plugin\n  config:\n    mode: attack\n`);

  const rescued = await run(home, ['rescue', '--yes', '--json']);
  assert.equal(rescued.code, 0);
  const payload = rescued.json();
  assert.equal(payload.verified, true);
  assert.ok(payload.reversed.some((line) => line.includes('conflicting-plugin')), JSON.stringify(payload.reversed));
  assert.ok(payload.reversed.some((line) => line.includes('新增 bundle')), JSON.stringify(payload.reversed));

  assert.equal(readFileOrNull(home.patchFile), DEFAULT_PATCH);
  assert.equal(readJsonFile(home.packageFile).dsh.profile.bundles.includes('conflicting-plugin'), false);
});

test('配置没变但包变了时 rescue 会明说"不是配置问题"', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  await run(home, ['good', '--json']);

  const rescued = await run(home, ['rescue', '--yes']);
  assert.equal(rescued.code, 0);
  assert.match(rescued.out, /不是配置/);
  assert.match(rescued.out, /逐字节一致/);
});

test('救援前的现场快照保留了被破坏的配置，可二次回看', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  await run(home, ['good', '--json']);
  fs.writeFileSync(home.patchFile, '[]\n');

  const rescued = await run(home, ['rescue', '--yes', '--json']);
  const preId = rescued.json().preSnapshotId;
  assert.ok(preId);

  const snapshotFile = path.join(home.home, 'rescue', 'snapshots', preId, 'files', 'profiles', 'desktop', 'cordis.patch.yml');
  assert.equal(fs.readFileSync(snapshotFile, 'utf8'), '[]\n');
});