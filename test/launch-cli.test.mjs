import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { DEFAULT_PATCH, makeHome, makeIo, readFileOrNull, removeDir, tempDir } from './helpers/fixture.mjs';

const NOT_RUNNING = () => ({ known: true, names: [] });
const RUNNING = () => ({ known: true, names: ['DeepSeek Harness.exe'] });

function fakeChild(pid, log = {}) {
  return {
    pid,
    handlers: {},
    once(event, callback) {
      this.handlers[event] = callback;
    },
    unref() {
      log.unrefs = (log.unrefs ?? 0) + 1;
    },
  };
}

function fakeApp(root, name = 'DeepSeek Harness.exe') {
  const appDir = path.join(root, 'DeepSeek Harness');
  fs.mkdirSync(appDir, { recursive: true });
  const exe = path.join(appDir, name);
  fs.writeFileSync(exe, 'stub');
  return exe;
}

function clocked(step) {
  let value = 0;
  return () => {
    value += step;
    return value;
  };
}

test('launch --dry-run 只打印计划，不启动任何东西', async (t) => {
  const home = makeHome();
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);
  const capture = makeIo({ home: home.home, detector: NOT_RUNNING });
  const code = await runCli(['launch', '--dry-run', '--json', '--app', exe], capture.io);
  assert.equal(code, 0);
  const payload = capture.json();
  assert.equal(payload.dryRun, true);
  assert.equal(payload.executable, exe);
  assert.equal(payload.bootTimeoutMs, 90_000);
});

test('已经有实例在跑时拒绝再启动一个', async (t) => {
  const home = makeHome();
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);
  const capture = makeIo({ home: home.home, detector: RUNNING });
  const code = await runCli(['launch', '--json', '--app', exe], capture.io);
  assert.equal(code, 1);
  assert.equal(capture.json().reason, 'already-running');
});

test('启动成功后返回 0，并让应用继续运行（unref）', async (t) => {
  const home = makeHome();
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);
  const log = {};
  const capture = makeIo({
    home: home.home,
    detector: NOT_RUNNING,
    spawn: () => fakeChild(9001, log),
    probe: () => true,
    sleep: async () => {},
    now: clocked(10),
  });
  const code = await runCli(['launch', '--json', '--app', exe], capture.io);
  assert.equal(code, 0, capture.stderr());
  assert.equal(capture.json().ok, true);
  assert.equal(log.unrefs, 1);
});

test('卡死 → 杀掉 → 回滚到 good → 重试；两次都卡就退出码 1', async (t) => {
  const home = makeHome();
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);

  const good = makeIo({ home: home.home, detector: NOT_RUNNING });
  assert.equal(await runCli(['good', '--json'], good.io), 0);
  fs.writeFileSync(home.patchFile, '[]\n');

  const kills = [];
  const capture = makeIo({
    home: home.home,
    detector: NOT_RUNNING,
    spawn: () => fakeChild(7000 + kills.length),
    exec: (file, args) => {
      kills.push([file, ...args]);
      return '';
    },
    probe: () => false,
    sleep: async () => {},
    now: clocked(40_000),
  });

  const code = await runCli(['launch', '--json', '--app', exe], capture.io);
  assert.equal(code, 1, capture.stderr());
  const payload = capture.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.attempts.length, 2);
  assert.equal(payload.attempts[0].killed, true);
  assert.ok(payload.attempts[0].restored.snapshotId, '第一次失败后应该已经回滚');
  assert.equal(readFileOrNull(home.patchFile), DEFAULT_PATCH, 'patch 应该被救回来了');
});

test('--no-auto-restore 时只杀不回滚', async (t) => {
  const home = makeHome();
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);
  const good = makeIo({ home: home.home, detector: NOT_RUNNING });
  assert.equal(await runCli(['good', '--json'], good.io), 0);
  fs.writeFileSync(home.patchFile, '[]\n');

  const capture = makeIo({
    home: home.home,
    detector: NOT_RUNNING,
    spawn: () => fakeChild(6001),
    exec: () => '',
    probe: () => false,
    sleep: async () => {},
    now: clocked(40_000),
  });
  const code = await runCli(['launch', '--json', '--no-auto-restore', '--boot-timeout', '30', '--app', exe], capture.io);
  assert.equal(code, 1);
  assert.equal(capture.json().attempts[0].restored, null);
  assert.equal(readFileOrNull(home.patchFile), '[]\n', '不许偷偷回滚');
});

test('--boot-timeout 非法时报用法错误', async (t) => {
  const home = makeHome();
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);
  const capture = makeIo({ home: home.home, detector: NOT_RUNNING });
  const code = await runCli(['launch', '--boot-timeout', '0', '--app', exe], capture.io);
  assert.equal(code, 2);
  assert.match(capture.stderr(), /正整数/);
});