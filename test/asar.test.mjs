import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { readAsarEntry, readAsarJson } from '../src/asar.mjs';
import { buildAsar, writeAsar } from './helpers/asar-builder.mjs';
import { removeDir, tempDir } from './helpers/fixture.mjs';

test('能从一个 asar 里读出指定条目', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const asar = writeAsar(dir, {
    'a.txt': 'hello',
    'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json': '{"version":"0.2.1-rc.3"}',
  });
  assert.equal(readAsarEntry(asar, 'a.txt').toString('utf8'), 'hello');
  assert.deepEqual(readAsarJson(asar, 'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json'), {
    version: '0.2.1-rc.3',
  });
});

test('条目不存在、路径是目录、文件本身不存在时返回 null', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const asar = writeAsar(dir, { 'a/b.txt': 'x' });
  assert.equal(readAsarEntry(asar, 'missing.txt'), null);
  assert.equal(readAsarEntry(asar, 'a'), null, '目录节点没有 offset/size');
  assert.equal(readAsarEntry(path.join(dir, 'nope.asar'), 'a/b.txt'), null);
});

test('截断的 asar 不会抛异常', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const full = buildAsar({ 'a.txt': 'hello world' });
  const target = path.join(dir, 'cut.asar');
  fs.writeFileSync(target, full.subarray(0, full.length - 5));
  assert.equal(readAsarEntry(target, 'a.txt'), null);
});

test('坏 JSON 目录树返回 null', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const target = path.join(dir, 'bad.asar');
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4 + 5, 8);
  head.writeUInt32LE(5, 12);
  fs.writeFileSync(target, Buffer.concat([head, Buffer.from('notjs')]));
  assert.equal(readAsarEntry(target, 'a.txt'), null);
});

test('条目内容不是 JSON 时 readAsarJson 返回 null', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const asar = writeAsar(dir, { 'pkg.json': 'not json at all' });
  assert.equal(readAsarJson(asar, 'pkg.json'), null);
  assert.equal(readAsarEntry(asar, 'pkg.json').toString('utf8'), 'not json at all');
});