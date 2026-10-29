import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { latestCrash, listCrashReports, parseCrashReport } from '../src/crash.mjs';
import { removeDir, tempDir } from './helpers/fixture.mjs';

const SAMPLE = `time: 2026-10-19T13:40:20.298Z
source: host
phase: running
app: @deepseek-ai/dsh-desktop 0.2.1-rc.2
platform: win32 x64
electron: 44.7.0
node: 24.21.0
locale: zh-CN
shell pid: 49756

--- error ---
Error: dsh desktop host exited with 1073807364: dsh: skipping profile bundle "@memtensor/memos-local-plugin": Error: Plugin @memtensor/memos-local-plugin@2.0.20 is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-agent":">=0.1.0-rc.5 <0.2.0"}. Running it may cause crashes or data loss.
'npx' 不是内部或外部命令，也不是可运行的程序
dsh: warning: 1 entry did not activate
better-sidebar (dsh-better-sidebar): pending (waiting for service: webRuntime)
    at ChildProcess.<anonymous> (file:///C:/app.asar/lib/main.js:3844:64)
    at ChildProcess.emit (node:events:514:28)

--- renderer console (error level, oldest first) ---
boom
`;

test('解析真实崩溃报告的关键事实', () => {
  const facts = parseCrashReport(SAMPLE);
  assert.equal(facts.source, 'host');
  assert.equal(facts.exitCode, 1073807364);
  assert.deepEqual(facts.skippedBundles, ['@memtensor/memos-local-plugin']);
  assert.deepEqual(facts.incompatible, [
    { package: '@memtensor/memos-local-plugin', version: '2.0.20', runtime: '0.2.1-rc.2' },
  ]);
  assert.equal(facts.entriesFailed, 1);
  assert.deepEqual(facts.pending, [
    { entry: 'better-sidebar', package: 'dsh-better-sidebar', reason: 'waiting for service: webRuntime' },
  ]);
  assert.match(facts.title, /^Error: dsh desktop host exited with 1073807364/);
});

test('GBK 乱码字节与超长首行都不会让它抛异常', () => {
  const garbage = Buffer.concat([
    Buffer.from('--- error ---\nError: host exited with 1\n'),
    Buffer.from([0xb2, 0xbb, 0xc4, 0xdc, 0xb7, 0xa2, 0xcf, 0xd6]), // GBK "不能发现"
    Buffer.from(`\n${'x'.repeat(2000)}\n`),
  ]).toString('utf8');
  const facts = parseCrashReport(garbage);
  assert.equal(facts.exitCode, 1);
  assert.ok(facts.title.length <= 301);
});

test('空文本与畸形文本返回空事实而不是崩', () => {
  assert.equal(parseCrashReport('').exitCode, null);
  assert.equal(parseCrashReport(undefined).source, null);
  assert.equal(parseCrashReport('???').title, '???');
});

test('listCrashReports 只认 DSH 的报告命名，并按时间倒序', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  fs.writeFileSync(path.join(dir, 'crash-2026-10-19T13-40-20-298Z-host.log'), SAMPLE);
  fs.writeFileSync(path.join(dir, 'crash-2026-10-20T10-00-00-000Z-renderer.log'), '--- error ---\nboom\n');
  fs.writeFileSync(path.join(dir, 'something-else.log'), 'ignore me');
  fs.writeFileSync(path.join(dir, 'crash-not-a-date.log'), 'ignore me too');

  const reports = listCrashReports([dir, path.join(dir, 'missing')]);
  assert.equal(reports.length, 2);
  assert.ok(reports[0].mtimeMs >= reports[1].mtimeMs);
});

test('latestCrash 返回最新的那份并附上解析结果', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const target = path.join(dir, 'crash-2026-10-19T13-40-20-298Z-host.log');
  fs.writeFileSync(target, SAMPLE);
  const crash = latestCrash([dir]);
  assert.equal(crash.path, target);
  assert.equal(crash.facts.exitCode, 1073807364);
});

test('没有报告时返回 null', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  assert.equal(latestCrash([dir]), null);
  assert.equal(latestCrash([]), null);
});