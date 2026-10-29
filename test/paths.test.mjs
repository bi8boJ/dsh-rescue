import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { absoluteFor, expandHome, resolveHome, resolveLayout } from '../src/paths.mjs';

test('stateFiles 覆盖五个配置层，且 rel 用 posix 分隔', () => {
  const layout = resolveLayout({ home: path.join('tmp', 'home'), platform: 'linux', homedir: '/home/u' });
  assert.deepEqual(
    layout.stateFiles.map((file) => file.key),
    ['profilePackage', 'profilePatch', 'profileCompat', 'profileWorkspace', 'homePatch'],
  );
  for (const file of layout.stateFiles) {
    assert.ok(!file.rel.includes('\\'), `${file.rel} 必须用 / 分隔`);
  }
  assert.equal(layout.stateFiles.find((file) => file.key === 'profilePackage').required, true);
  assert.equal(layout.stateFiles.find((file) => file.key === 'homePatch').rel, 'cordis.patch.yml');
});

test('home 优先级：显式参数 > DSH_HOME > ~/.dsh', () => {
  const explicit = resolveHome({ home: path.join('a', 'b'), env: { DSH_HOME: path.join('c', 'd') }, homedir: path.join('h') });
  assert.equal(explicit, path.resolve(path.join('a', 'b')));

  const fromEnv = resolveHome({ env: { DSH_HOME: path.join('c', 'd') }, homedir: path.join('h') });
  assert.equal(fromEnv, path.resolve(path.join('c', 'd')));

  const fallback = resolveHome({ env: {}, homedir: path.join('h') });
  assert.equal(fallback, path.join(path.join('h'), '.dsh'));
});

test('~ 会展开到 homedir', () => {
  assert.equal(expandHome('~', '/home/u'), '/home/u');
  assert.equal(expandHome('~/x/y', '/home/u'), path.join('/home/u', 'x/y'));
  assert.equal(expandHome('/abs', '/home/u'), '/abs');
});

test('profile 名字会进到 rel 里', () => {
  const layout = resolveLayout({ home: 'h', profile: 'web', platform: 'linux', homedir: '/home/u' });
  assert.equal(layout.profileDir, path.join(path.resolve('h'), 'profiles', 'web'));
  assert.equal(layout.stateFiles[0].rel, 'profiles/web/package.json');
});

test('win32 的崩溃日志目录包含桌面版与 electron-user-data 两处', () => {
  const layout = resolveLayout({
    home: path.join('C:', 'dsh'),
    platform: 'win32',
    env: { APPDATA: path.join('C:', 'AppData', 'Roaming') },
    homedir: path.join('C:', 'Users', 'u'),
  });
  assert.equal(layout.crashDirs.length, 2);
  assert.ok(layout.crashDirs[0].includes('dsh-desktop'));
  assert.ok(layout.crashDirs[1].includes('electron-user-data'));
});

test('absoluteFor 把 posix rel 拼回绝对路径', () => {
  const joined = absoluteFor(path.join('root'), 'profiles/desktop/package.json');
  assert.equal(joined, path.join('root', 'profiles', 'desktop', 'package.json'));
});