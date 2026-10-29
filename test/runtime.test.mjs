import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveLayout } from '../src/paths.mjs';
import { asarCandidates, detectRuntime, RUNTIME_MANIFEST, versionFromAsar } from '../src/runtime.mjs';
import { removeDir, tempDir } from './helpers/fixture.mjs';
import { buildAsar, writeAsar } from './helpers/asar-builder.mjs';

function runtimeAsar(dir, version) {
  return writeAsar(dir, { [RUNTIME_MANIFEST]: JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version }) });
}

test('优先从 app.asar 读运行时版本，不启动子进程', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const asar = runtimeAsar(dir, '0.2.1-rc.3');
  let spawned = false;
  const result = detectRuntime({
    env: { LOCALAPPDATA: path.join(dir, 'nowhere') },
    platform: 'win32',
    asarPath: asar,
    spawn: () => {
      spawned = true;
      throw new Error('should not spawn');
    },
  });
  assert.equal(result.version, '0.2.1-rc.3');
  assert.equal(result.source, 'asar');
  assert.equal(spawned, false);
});

test('asar 里没有该清单时返回 null', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const asar = writeAsar(dir, { 'other/file.txt': 'x' });
  assert.equal(versionFromAsar(asar), null);
  assert.equal(versionFromAsar(path.join(dir, 'missing.asar')), null);
});

test('asar 里的版本号不像版本时也返回 null', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const asar = writeAsar(dir, { [RUNTIME_MANIFEST]: JSON.stringify({ version: 'not-a-version' }) });
  assert.equal(versionFromAsar(asar), null);
});

test('asar 读不到时退化到 CLI，.cmd 通过 cmd.exe 调用', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const calls = [];
  const result = detectRuntime({
    env: { LOCALAPPDATA: path.join(dir, 'nowhere') },
    platform: 'win32',
    asarPath: path.join(dir, 'nope.asar'),
    spawn: (file, args, options) => {
      calls.push({ file, args, verbatim: options && options.windowsVerbatimArguments });
      return { stdout: '0.2.1-rc.3\n' };
    },
  });
  assert.equal(result.version, '0.2.1-rc.3');
  assert.equal(result.source, 'cli');
  assert.equal(calls.length, 1);
  assert.equal(path.basename(calls[0].file).toLowerCase(), (process.env.ComSpec || 'cmd.exe').toLowerCase().split(path.sep).pop());
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(calls[0].verbatim, true);
});

test('什么都找不到时返回 version:null，不抛异常', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const result = detectRuntime({
    env: { LOCALAPPDATA: path.join(dir, 'nowhere') },
    platform: 'win32',
    asarPath: path.join(dir, 'nope.asar'),
    spawn: () => {
      throw new Error('nope');
    },
  });
  assert.equal(result.version, null);
  assert.equal(result.source, 'none');
});

test('缓存一小时内生效，过期后重新探测', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const home = path.join(dir, 'home');
  const layout = resolveLayout({ home, profile: 'desktop', platform: 'win32', homedir: dir });
  const asar = runtimeAsar(dir, '0.2.1-rc.3');

  const first = detectRuntime({ layout, asarPath: asar, env: {}, platform: 'win32' });
  assert.equal(first.source, 'asar');

  const cached = detectRuntime({ layout, asarPath: asar, env: {}, platform: 'win32' });
  assert.equal(cached.source, 'cache');
  assert.equal(cached.version, '0.2.1-rc.3');

  const stale = detectRuntime({
    layout,
    asarPath: path.join(dir, 'gone.asar'),
    env: {},
    platform: 'win32',
    now: first.detectedAt + 2 * 60 * 60 * 1000,
    spawn: () => {
      throw new Error('no cli');
    },
  });
  assert.equal(stale.version, null, '过了 TTL 就应该重新探测');
});

test('asarCandidates 覆盖常见安装位置', () => {
  const win = asarCandidates({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\PF' }, platform: 'win32' });
  assert.ok(win.some((entry) => entry.includes('DeepSeek Harness')));
  assert.ok(win.every((entry) => entry.endsWith('app.asar')));
  const mac = asarCandidates({ env: {}, platform: 'darwin' });
  assert.ok(mac[0].includes('DeepSeek Harness.app'));
});