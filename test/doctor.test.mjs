import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { collectKnownIds, isShippedBundle, runDoctor } from '../src/doctor.mjs';
import { SHIPPED_BUNDLES, makeHome, removeDir, tempDir, writeManifest } from './helpers/fixture.mjs';
import { writeAsar } from './helpers/asar-builder.mjs';

const RUNTIME = '0.2.1-rc.3';

function codes(result) {
  return result.findings.map((finding) => finding.code);
}

function doctor(home, options = {}) {
  return runDoctor({
    home: home.home,
    profile: 'desktop',
    runtimeVersion: options.runtimeVersion === undefined ? RUNTIME : options.runtimeVersion,
    ...options.extra,
  });
}

test('健康 profile 体检通过', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.errorsCount, 0);
  assert.equal(result.summary.bundles, 3);
});

test('空 patch 是高亮错误（空文件会让启动直接失败）', (t) => {
  const home = makeHome({ patch: '' });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('patch.empty'));
  const finding = result.findings.find((entry) => entry.code === 'patch.empty');
  assert.match(finding.hint, /\[\]/);
});

test('只有注释的 patch 等价于空', (t) => {
  const home = makeHome({ patch: '# 全是注释\n# 还是注释\n' });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  assert.ok(codes(result).includes('patch.commentsOnly'));
  assert.equal(result.ok, false);
});

test('家目录级 patch 为空也会报（且优先级更高）', (t) => {
  const home = makeHome({ homePatch: '' });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  const finding = result.findings.find((entry) => entry.code === 'patch.empty' && entry.message.includes('家目录'));
  assert.ok(finding);
});

test('package.json 是坏 JSON', (t) => {
  const home = makeHome({ packageJson: '{"dependencies": {' });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  assert.ok(codes(result).includes('profile.json.invalid'));
  assert.equal(result.ok, false);
});

test('profile 完全不存在', (t) => {
  const home = makeHome({ writePackageJson: false });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  assert.ok(codes(result).includes('profile.missing'));
});

test('bundles 不是数组', (t) => {
  const home = makeHome({ bundlesRaw: { nope: true } });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  assert.ok(codes(result).includes('bundles.notArray'));
});

test('bundles 有重复项会被警告', (t) => {
  const home = makeHome({ bundles: [...SHIPPED_BUNDLES, 'dsh-fake-plugin', 'dsh-fake-plugin'] });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  assert.ok(codes(result).includes('bundles.duplicate'));
  assert.equal(result.ok, true);
});

test('依赖里声明了但 node_modules 里没目录 → dep.missing（警告）', (t) => {
  const home = makeHome({
    bundles: [...SHIPPED_BUNDLES, 'dsh-fake-plugin'],
    deps: { 'dsh-fake-plugin': '^1.0.0', ghost: '^1.0.0' },
  });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  const finding = result.findings.find((entry) => entry.code === 'dep.missing');
  assert.ok(finding);
  assert.match(finding.message, /ghost/);
  assert.equal(result.ok, true, '别的都好的时候，孤儿依赖只警告');
});

test('bundle 在依赖里但目录被删 → bundle.missing（错误）', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  fs.rmSync(path.join(home.nodeModules, 'dsh-fake-plugin'), { recursive: true, force: true });
  const result = doctor(home);
  assert.ok(codes(result).includes('bundle.missing'));
  assert.equal(result.ok, false);
});

test('依赖键与包实际 name 不一致 → dep.keyMismatch（Desktop 会进恢复模式）', (t) => {
  const home = makeHome({ bundles: [...SHIPPED_BUNDLES, 'renamed-pkg'] });
  t.after(() => removeDir(home.home));
  writeManifest(home.profileDir, 'renamed-pkg', { name: 'original-name', version: '1.0.0' });
  const result = doctor(home);
  assert.ok(codes(result).includes('dep.keyMismatch'));
  assert.ok(codes(result).includes('bundle.nameMismatch'));
  assert.equal(result.ok, false);
});

test('版本闸门不匹配 → gate.incompatible', (t) => {
  const home = makeHome({ packages: { 'dsh-fake-plugin': { peerDependencies: { '@deepseek-ai/dsh': '^0.1.0' } } } });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  const finding = result.findings.find((entry) => entry.code === 'gate.incompatible');
  assert.ok(finding);
  assert.match(finding.message, /\^0\.1\.0/);
  assert.equal(result.ok, false);
});

test('engines.dsh 存在时忽略 peerDependencies（闸门规则）', (t) => {
  const home = makeHome({
    packages: {
      'dsh-fake-plugin': {
        engines: { dsh: '^0.1.0' },
        peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' },
      },
    },
  });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  const finding = result.findings.find((entry) => entry.code === 'gate.incompatible');
  assert.ok(finding, 'engines.dsh 说不兼容就该不兼容，哪怕 peer 说可以');
  assert.match(finding.message, /engines\.dsh/);
});

test('探测不到运行时版本 → gate.unknown（信息，不算错）', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const result = doctor(home, { runtimeVersion: null });
  assert.ok(codes(result).includes('gate.unknown'));
  assert.equal(result.ok, true);
});

test('compatibility.json 坏了只警告', (t) => {
  const home = makeHome({ compat: '{ not json' });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  assert.ok(codes(result).includes('compat.invalid'));
  assert.equal(result.ok, true);
});

test('版本豁免在插件升级后过期 → compat.stale', (t) => {
  const home = makeHome({ compat: { 'dsh-fake-plugin@0.9.0': ['0.2.1-rc.3'] } });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  const finding = result.findings.find((entry) => entry.code === 'compat.stale');
  assert.ok(finding);
  assert.match(finding.message, /0\.9\.0/);
});

test('装了但没启用的插件 → dep.notEnabled（信息）', (t) => {
  const home = makeHome({ packages: { 'extra-plugin': { version: '1.0.0' } }, deps: { 'extra-plugin': '^1.0.0' } });
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  assert.ok(codes(result).includes('dep.notEnabled'));
});

test('collectKnownIds 从 bundle 自己的 patch 里收集 id', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const collected = collectKnownIds({ profileDir: home.profileDir, bundleNames: ['dsh-fake-plugin'] });
  assert.equal(collected.complete, true);
  assert.ok(collected.ids.has('llm-pi-ai'));
  assert.ok(collected.ids.has('compaction-basic'));
});

test('拿不到出厂 bundle 的补丁时，unknownId 检查会被跳过', (t) => {
  const home = makeHome({ patch: '- id: llm-pi-ai\n- id: from-shipped-bundle\n' });
  t.after(() => removeDir(home.home));
  const collected = collectKnownIds({
    profileDir: home.profileDir,
    bundleNames: [...SHIPPED_BUNDLES, 'dsh-fake-plugin'],
  });
  assert.equal(collected.complete, false, '出厂 bundle 不在 profile 的 node_modules 里，必然读不到');
  const result = runDoctor({ home: home.home, profile: 'desktop', runtimeVersion: RUNTIME, knownIds: collected });
  assert.ok(result.findings.some((entry) => entry.code === 'patch.idsUnverified'));
  assert.equal(result.findings.some((entry) => entry.code === 'patch.unknownId'), false);
  assert.equal(result.ok, true);
});

test('patch 指向不存在的 id → info（宿主只会 warn）', (t) => {
  const home = makeHome({ patch: '- id: llm-pi-ai\n- id: mystery-id\n' });
  t.after(() => removeDir(home.home));
  const knownIds = collectKnownIds({ profileDir: home.profileDir, bundleNames: ['dsh-fake-plugin'] });
  const result = runDoctor({ home: home.home, profile: 'desktop', runtimeVersion: RUNTIME, knownIds });
  const finding = result.findings.find((entry) => entry.code === 'patch.unknownId');
  assert.ok(finding);
  assert.match(finding.message, /mystery-id/);
  assert.equal(result.ok, true);
});

test('hash 与 bytes 一致的快照式摘要', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const result = doctor(home);
  assert.ok(result.summary.patchBytes > 0);
  assert.equal(result.summary.patchEntries, 2);
  assert.equal(isShippedBundle('@deepseek-ai/dsh-base'), true);
  assert.equal(isShippedBundle('dsh-pet'), false);
});

test('安装包内置的 bundle 不再被当成"没装"（DSH NEXT 就是这种）', (t) => {
  const home = makeHome({ bundles: [...SHIPPED_BUNDLES, 'app-only-plugin'], deps: {} });
  t.after(() => removeDir(home.home));
  fs.rmSync(path.join(home.nodeModules, 'app-only-plugin'), { recursive: true, force: true });

  const asarDir = tempDir();
  t.after(() => removeDir(asarDir));
  const asar = writeAsar(asarDir, {
    'node_modules/app-only-plugin/package.json': JSON.stringify({
      name: 'app-only-plugin',
      version: '1.2.3',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
      peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' },
    }),
  });

  const result = runDoctor({
    home: home.home,
    profile: 'desktop',
    runtimeVersion: RUNTIME,
    asarPaths: [asar],
  });
  assert.equal(result.findings.some((entry) => entry.code === 'bundle.notInstalled'), false);
  assert.ok(result.findings.some((entry) => entry.code === 'bundle.fromApp'));
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test('主应用与 NEXT 同时运行 → 明确警告"插件抢文件"', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const both = runDoctor({
    home: home.home,
    profile: 'desktop',
    runtimeVersion: RUNTIME,
    instances: { main: 3, next: 2 },
  });
  const finding = both.findings.find((entry) => entry.code === 'instances.dualHome');
  assert.ok(finding);
  assert.equal(finding.level, 'warn');
  assert.match(finding.hint, /只留一个/);

  const onlyMain = runDoctor({
    home: home.home,
    profile: 'desktop',
    runtimeVersion: RUNTIME,
    instances: { main: 3, next: 0 },
  });
  assert.equal(onlyMain.findings.some((entry) => entry.code === 'instances.dualHome'), false);
});

test('profile 里有 NEXT 的痕迹 → 提示还原可能去掉 NEXT 的键', (t) => {
  const home = makeHome({
    packageJson: { dependencies: {}, dsh: { profile: { bundles: [...SHIPPED_BUNDLES] }, desktopNextPlugins: [] } },
  });
  t.after(() => removeDir(home.home));
  const result = runDoctor({ home: home.home, profile: 'desktop', runtimeVersion: RUNTIME });
  const finding = result.findings.find((entry) => entry.code === 'profile.sharedWithNext');
  assert.ok(finding);
  assert.match(finding.hint, /NEXT/);
});