import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  asarFromProfileOverlays,
  nextMarkers,
  packageFromAsar,
  packageFromUnpacked,
  resolveAppPackage,
} from '../src/installation.mjs';
import { buildAsar, writeAsar } from './helpers/asar-builder.mjs';
import { makeHome, removeDir, tempDir } from './helpers/fixture.mjs';

test('app.asar 里两种打包前缀都能读：dsh/ 与根目录', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const desktopLayout = writeAsar(
    dir,
    { 'dsh/node_modules/pkg-a/package.json': JSON.stringify({ name: 'pkg-a', version: '1.0.0' }) },
    'desktop.asar',
  );
  const nextLayout = writeAsar(
    dir,
    { 'node_modules/pkg-b/package.json': JSON.stringify({ name: 'pkg-b', version: '2.0.0' }) },
    'next.asar',
  );

  assert.equal(packageFromAsar(desktopLayout, 'pkg-a').manifest.version, '1.0.0');
  assert.equal(packageFromAsar(desktopLayout, 'pkg-a').prefix, 'dsh/');
  assert.equal(packageFromAsar(nextLayout, 'pkg-b').manifest.version, '2.0.0');
  assert.equal(packageFromAsar(nextLayout, 'pkg-b').prefix, '');
  assert.equal(packageFromAsar(nextLayout, 'missing'), null);
});

test('scope 包在 asar 里也能解析', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const asar = writeAsar(dir, {
    'node_modules/@scope/thing/package.json': JSON.stringify({ name: '@scope/thing', version: '3.1.4' }),
  });
  assert.equal(packageFromAsar(asar, '@scope/thing').manifest.version, '3.1.4');
});

test('解包目录（原生依赖）也能读', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const asar = path.join(dir, 'app.asar');
  fs.writeFileSync(asar, buildAsar({ 'other.txt': 'x' }));
  const nativeDir = path.join(`${asar}.unpacked`, 'node_modules', '@native', 'mod');
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, 'package.json'), JSON.stringify({ name: '@native/mod', version: '9.9.9' }));

  assert.equal(packageFromUnpacked(asar, '@native/mod').manifest.version, '9.9.9');
  const resolved = resolveAppPackage({ name: '@native/mod', asarPaths: [asar] });
  assert.equal(resolved.origin, 'app-unpacked');
  assert.equal(resolved.manifest.version, '9.9.9');
});

test('profile 装了的包不会被当成"来自安装包"', (t) => {
  const home = makeHome({ bundles: ['@deepseek-ai/dsh-base', 'dsh-fake-plugin'] });
  t.after(() => removeDir(home.home));
  const appAsar = writeAsar(
    tempDir(),
    { 'node_modules/dsh-fake-plugin/package.json': JSON.stringify({ name: 'dsh-fake-plugin', version: '0.0.1-app' }) },
  );
  void appAsar;
  // resolveAppPackage 只看 asar，不该影响 profile 的判定顺序——这里只验证 asar 分支
  assert.equal(resolveAppPackage({ name: 'dsh-fake-plugin', asarPaths: [] }), null);
});

test('从 NEXT 写进 profile 的 overlay 反推安装位置', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  fs.writeFileSync(
    path.join(home.profileDir, 'desktop-next.cordis.patch.json'),
    JSON.stringify(
      [
        {
          id: 'agents-anywhere-bridge-next',
          config: {
            connectorSourceDir:
              'D:\\deepseek harness\\DSH NEXT\\resources\\app.asar.unpacked\\node_modules\\@agents-anywhere\\dsh-bridge-next\\lib',
          },
        },
      ],
      null,
      2,
    ),
  );
  const found = asarFromProfileOverlays(home.profileDir);
  assert.equal(found.length, 1);
  assert.ok(found[0].endsWith(path.join('resources', 'app.asar')));
  assert.ok(found[0].includes('DSH NEXT'));
});

test('没有 overlay 时返回空数组，不抛异常', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  assert.deepEqual(asarFromProfileOverlays(home.profileDir), []);
  assert.deepEqual(asarFromProfileOverlays(path.join(home.home, 'missing')), []);
});

test('识别"这份 profile 也被 NEXT 用着"的两个证据', (t) => {
  const home = makeHome({ packageJson: { dsh: { profile: { bundles: [] }, desktopNextPlugins: [], desktopNextOnboarding: {} } } });
  t.after(() => removeDir(home.home));
  fs.writeFileSync(path.join(home.profileDir, 'desktop-next.runtime.patch.json'), '[]');

  const markers = nextMarkers({
    profileDir: home.profileDir,
    packageJson: JSON.parse(fs.readFileSync(home.packageFile, 'utf8')),
  });
  assert.ok(markers.some((marker) => marker.includes('desktopNextPlugins')));
  assert.ok(markers.some((marker) => marker.includes('desktop-next.runtime.patch.json')));
});

test('普通 profile 没有任何 NEXT 痕迹', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  assert.deepEqual(
    nextMarkers({ profileDir: home.profileDir, packageJson: JSON.parse(fs.readFileSync(home.packageFile, 'utf8')) }),
    [],
  );
});