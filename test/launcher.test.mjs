import assert from 'node:assert/strict';
import test from 'node:test';

import { launchGuarded, makeLauncher, makeProbe } from '../src/launcher.mjs';

function fakeChild(pid) {
  return {
    pid,
    handlers: {},
    unrefCalled: false,
    once(event, callback) {
      this.handlers[event] = callback;
    },
    unref() {
      this.unrefCalled = true;
    },
    emitExit() {
      this.handlers.exit?.();
    },
  };
}

test('makeLauncher 把 pid / 存活 / kill 包在一个对象里', () => {
  const child = fakeChild(101);
  const launch = makeLauncher({ executable: 'C:\\x\\DeepSeek Harness.exe', spawnImpl: () => child, platform: 'win32' });
  const app = launch({ attempt: 1 });
  assert.equal(app.pid, 101);
  assert.equal(app.exited(), false);
  child.emitExit();
  assert.equal(app.exited(), true);
});

test('win32 用 taskkill /T 杀整棵树，且已退出的进程不再杀', () => {
  const calls = [];
  const child = fakeChild(202);
  const launch = makeLauncher({
    executable: 'C:\\x\\app.exe',
    spawnImpl: () => child,
    platform: 'win32',
    exec: (file, args) => {
      calls.push([file, args]);
    },
  });
  const app = launch();
  app.kill();
  assert.deepEqual(calls, [['taskkill', ['/PID', '202', '/T', '/F']]]);

  child.emitExit();
  app.kill();
  assert.equal(calls.length, 1, '进程已经退出就不该再 taskkill');
});

test('makeProbe 用图像名判断就绪', () => {
  const probe = makeProbe({
    executable: 'C:\\x\\DeepSeek Harness.exe',
    platform: 'win32',
    exec: (file) =>
      file === 'netstat'
        ? '  TCP    127.0.0.1:49862    0.0.0.0:0    LISTENING    2740\n'
        : '"DeepSeek Harness.exe","2740","Console","1","1 K"\n',
  });
  assert.equal(probe(), true);
});

test('启动成功后会 unref，让 CLI 退出时应用继续跑', async () => {
  let child;
  const result = await launchGuarded({
    executable: 'C:\\x\\app.exe',
    platform: 'win32',
    spawnImpl: () => {
      child = fakeChild(303);
      return child;
    },
    probe: () => true,
    sleep: async () => {},
    now: (() => {
      let value = 0;
      return () => (value += 10);
    })(),
    bootTimeoutMs: 1000,
  });
  assert.equal(result.ok, true);
  assert.equal(child.unrefCalled, true);
});

test('超时时真的会调 taskkill', async () => {
  const kills = [];
  let launches = 0;
  await launchGuarded({
    executable: 'C:\\x\\app.exe',
    platform: 'win32',
    spawnImpl: () => fakeChild(++launches),
    exec: (file, args) => kills.push([file, args]),
    probe: () => false,
    sleep: async () => {},
    now: (() => {
      let value = 0;
      return () => (value += 700);
    })(),
    bootTimeoutMs: 1000,
    maxAttempts: 1,
  });
  assert.deepEqual(kills, [['taskkill', ['/PID', '1', '/T', '/F']]]);
});