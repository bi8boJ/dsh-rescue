import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { DEFAULT_PATCH, SHIPPED_BUNDLES, makeHome, makeIo, readFileOrNull, readJsonFile, removeDir } from './helpers/fixture.mjs';

async function run(home, argv, options = {}) {
  const capture = makeIo({ home: options.homeOverride ?? home.home, ...options });
  const code = await runCli(argv, capture.io);
  return { code, out: capture.stdout(), err: capture.stderr(), json: () => capture.json() };
}

test('help 打印用法并列出所有命令', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const { code, out } = await run(home, ['help']);
  assert.equal(code, 0);
  assert.match(out, /用法/);
  for (const command of ['status', 'doctor', 'save', 'good', 'rescue', 'restore', 'safe-mode', 'undo', 'list', 'diff', 'crash']) {
    assert.match(out, new RegExp(command));
  }
});

test('--version 输出 package.json 里的版本', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const { code, out } = await run(home, ['--version']);
  assert.equal(code, 0);
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});

test('未知命令与未知选项都是退出码 2', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const unknownCommand = await run(home, ['frobnicate']);
  assert.equal(unknownCommand.code, 2);
  assert.match(unknownCommand.err, /未知命令/);

  const unknownFlag = await run(home, ['status', '--wat']);
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.err, /未知选项/);
});

test('缺参数值是用法错误', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const result = await run(home, ['status', '--home']);
  assert.equal(result.code, 2);
  assert.match(result.err, /需要一个值/);
});

test('status --json 在健康 profile 上返回 0 与结构化摘要', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const result = await run(home, ['status', '--json']);
  assert.equal(result.code, 0);
  const payload = result.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.doctor.ok, true);
  assert.equal(payload.summary.bundles, 3);
  assert.equal(payload.runtimeVersion, '0.2.1-rc.3');
  assert.equal(payload.good, null);
});

test('status 的人话输出包含体检结论与"先 good"建议', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const result = await run(home, ['status']);
  assert.equal(result.code, 0);
  assert.match(result.out, /体检通过/);
  assert.match(result.out, /dsh-rescue good/);
});

test('doctor --json 对空 patch 返回退出码 1 与 patch.empty', async (t) => {
  const home = makeHome({ patch: '' });
  t.after(() => removeDir(home.home));
  const result = await run(home, ['doctor', '--json']);
  assert.equal(result.code, 1);
  const payload = result.json();
  assert.equal(payload.ok, false);
  assert.ok(payload.findings.some((finding) => finding.code === 'patch.empty'));
});

test('save 与 good 各打一份快照，list 能列出并标出 good', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));

  const saved = await run(home, ['save', '--json', '-m', '手动']);
  assert.equal(saved.code, 0);
  assert.equal(saved.json().kind, 'manual');

  const good = await run(home, ['good', '--json']);
  assert.equal(good.code, 0);
  assert.equal(good.json().kind, 'good');

  const list = await run(home, ['list', '--json']);
  assert.equal(list.code, 0);
  const payload = list.json();
  assert.equal(payload.snapshots.length, 2);
  assert.equal(payload.good, good.json().id);
  assert.equal(payload.snapshots.filter((meta) => meta.good).length, 1);
});

test('体检不过时 good 拒绝，--force 才放行', async (t) => {
  const home = makeHome({ patch: '' });
  t.after(() => removeDir(home.home));
  const refused = await run(home, ['good', '--json']);
  assert.equal(refused.code, 1);
  assert.equal(refused.json().reason, 'doctor-failed');

  const forced = await run(home, ['good', '--json', '--force']);
  assert.equal(forced.code, 0);
});

test('没有 good 时 rescue 给出三条可执行的出路', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const result = await run(home, ['rescue']);
  assert.equal(result.code, 1);
  assert.match(result.out, /safe-mode/);
  assert.match(result.out, /restore <id>/);
  assert.match(result.out, /good/);
});

test('rescue：good → 破坏 → 一键还原，逐字节校验通过', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));

  const good = await run(home, ['good', '--json']);
  assert.equal(good.code, 0);
  const originalPackage = readFileOrNull(home.packageFile);

  // 模拟插件打架：少挂了一个 bundle、patch 被写成 []、多了一个 compatibility.json
  fs.writeFileSync(
    home.packageFile,
    `${JSON.stringify({ dependencies: { 'dsh-fake-plugin': '^1.0.0' }, dsh: { profile: { bundles: SHIPPED_BUNDLES } } }, null, 2)}\n`,
  );
  fs.writeFileSync(home.patchFile, '[]\n');
  fs.writeFileSync(path.join(home.profileDir, 'compatibility.json'), '{}\n');

  const result = await run(home, ['rescue', '--yes', '--json']);
  assert.equal(result.code, 0);
  const payload = result.json();
  assert.equal(payload.verified, true);
  assert.equal(readFileOrNull(home.packageFile), originalPackage);
  assert.equal(readFileOrNull(home.patchFile), DEFAULT_PATCH);
  assert.ok(payload.reversed.some((line) => line.includes('dsh-fake-plugin')), JSON.stringify(payload.reversed));
});

test('rescue 在非交互环境不加 --yes 会取消且不动文件', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  await run(home, ['good', '--json']);
  fs.writeFileSync(home.patchFile, '[]\n');

  const result = await run(home, ['rescue', '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.json().reason, 'cancelled');
  assert.equal(readFileOrNull(home.patchFile), '[]\n');
});

test('rescue --dry-run 只打印计划', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  await run(home, ['good', '--json']);
  fs.writeFileSync(home.patchFile, '[]\n');
  const result = await run(home, ['rescue', '--yes', '--dry-run', '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.json().dryRun, true);
  assert.equal(readFileOrNull(home.patchFile), '[]\n');
});

test('safe-mode 之后 undo 能回到原样', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const before = readJsonFile(home.packageFile).dsh.profile.bundles;

  const safe = await run(home, ['safe-mode', '--yes', '--json']);
  assert.equal(safe.code, 0);
  assert.deepEqual(readJsonFile(home.packageFile).dsh.profile.bundles, SHIPPED_BUNDLES);

  const undone = await run(home, ['undo', '--yes', '--json']);
  assert.equal(undone.code, 0);
  assert.deepEqual(readJsonFile(home.packageFile).dsh.profile.bundles, before);
});

test('diff 默认比较 good 与当前', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  await run(home, ['good', '--json']);
  const packageJson = readJsonFile(home.packageFile);
  packageJson.dsh.profile.bundles = [...packageJson.dsh.profile.bundles, 'late-plugin'];
  packageJson.dependencies['late-plugin'] = '^0.1.0';
  fs.writeFileSync(home.packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

  const result = await run(home, ['diff', '--json']);
  assert.equal(result.code, 0);
  const payload = result.json();
  assert.equal(payload.to, 'current');
  assert.deepEqual(payload.diff.bundles.added, ['late-plugin']);
});

test('crash 能读到 electron-user-data 下的崩溃报告', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const logs = path.join(home.home, 'electron-user-data', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(logs, 'crash-2026-10-29T01-02-03-004Z-host.log'),
    'time: 2026-10-29T01:02:03.004Z\nsource: host\n\n--- error ---\nError: dsh desktop host exited with 1073807364\n',
  );
  const result = await run(home, ['crash', '--json']);
  assert.equal(result.code, 0);
  const payload = result.json();
  assert.equal(payload.crash.facts.exitCode, 1073807364);
});

test('menu 在非交互环境只打印菜单', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const result = await run(home, ['menu', '--json']);
  assert.equal(result.code, 0);
  assert.match(result.out, /一键回滚到上次可用/);
});

test('--home 覆盖 DSH_HOME 环境变量', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const capture = makeIo({ home: path.join(home.home, 'nope') });
  const code = await runCli(['doctor', '--json', '--home', home.home], capture.io);
  assert.equal(code, 0);
  assert.equal(capture.json().ok, true);
});