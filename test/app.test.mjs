import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { appCandidates, executableBesideAsar, exeNameOf, resolveAppExecutable } from '../src/app.mjs';
import { removeDir, tempDir } from './helpers/fixture.mjs';

function layoutLike(appDirName, exeName) {
  const root = tempDir();
  const appDir = path.join(root, appDirName);
  const resources = path.join(appDir, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'stub');
  fs.writeFileSync(path.join(appDir, exeName), 'stub');
  return { root, appDir, asar: path.join(resources, 'app.asar') };
}

test('从 resources/app.asar 反推同目录下的可执行文件', (t) => {
  const { root, appDir, asar } = layoutLike('DeepSeek Harness', 'DeepSeek Harness.exe');
  t.after(() => removeDir(root));
  assert.equal(executableBesideAsar(asar), path.join(appDir, 'DeepSeek Harness.exe'));
  assert.equal(exeNameOf(executableBesideAsar(asar)), 'DeepSeek Harness.exe');
});

test('DSH NEXT 那种带空格的目录名也能识别', (t) => {
  const { root, appDir, asar } = layoutLike('DSH NEXT', 'DSH NEXT.exe');
  t.after(() => removeDir(root));
  assert.equal(executableBesideAsar(asar), path.join(appDir, 'DSH NEXT.exe'));
});

test('目录里没有 exe 时返回 null', (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const resources = path.join(root, 'SomeApp', 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'stub');
  assert.equal(executableBesideAsar(path.join(resources, 'app.asar')), null);
});

test('appCandidates 只返回真实存在的路径', (t) => {
  const { root, asar, appDir } = layoutLike('DeepSeek Harness', 'DeepSeek Harness.exe');
  t.after(() => removeDir(root));
  const found = appCandidates({ env: {}, platform: 'win32', asarPaths: [asar] });
  assert.deepEqual(found, [path.join(appDir, 'DeepSeek Harness.exe')]);
});

test('--app 优先，且不存在时报清楚的错', (t) => {
  const { root, appDir, asar } = layoutLike('DeepSeek Harness', 'DeepSeek Harness.exe');
  t.after(() => removeDir(root));
  const explicit = resolveAppExecutable({ app: path.join(appDir, 'DeepSeek Harness.exe') });
  assert.equal(explicit.source, 'flag');

  assert.throws(() => resolveAppExecutable({ app: path.join(root, 'nope.exe') }), /不存在/);
});

test('找不到任何安装时给出 --app 提示', () => {
  assert.throws(() => resolveAppExecutable({ env: {}, platform: 'linux' }), /--app/);
});