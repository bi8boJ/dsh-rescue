import assert from 'node:assert/strict';
import test from 'node:test';

import { runLaunchWatchdog } from '../src/bootwatch.mjs';

const sleep = async () => {};

function clocked(step) {
  let value = 0;
  return () => {
    value += step;
    return value;
  };
}

function fakeApp(pid, log) {
  let exited = false;
  return {
    pid,
    kill() {
      log.kills.push(pid);
      exited = true;
    },
    exited: () => exited,
    setExited() {
      exited = true;
    },
  };
}

test('就绪后立刻成功，不再等待', async () => {
  const app = fakeApp(11, { kills: [] });
  let probes = 0;
  const result = await runLaunchWatchdog({
    launch: () => app,
    probeReady: () => {
      probes += 1;
      return true;
    },
    sleep,
    now: clocked(10),
    bootTimeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'ready');
  assert.equal(result.attempts.length, 1);
  assert.equal(probes, 1);
  assert.equal(app.kill.name, 'kill');
});

test('超时 → 杀进程 → 回滚 → 重启一次，第二次成功', async () => {
  const kills = [];
  let launches = 0;
  const failures = [];
  const result = await runLaunchWatchdog({
    launch: () => {
      launches += 1;
      return fakeApp(launches, { kills });
    },
    probeReady: ({ attempt }) => attempt === 2,
    sleep,
    now: clocked(400),
    bootTimeoutMs: 1000,
    onFailure: async (info) => {
      failures.push(info.reason);
      return { ok: true, snapshotId: 'snap-1' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(launches, 2);
  assert.deepEqual(kills, [1]);
  assert.deepEqual(failures, ['timeout']);
  assert.equal(result.attempts[0].killed, true);
  assert.equal(result.attempts[0].restored.snapshotId, 'snap-1');
});

test('两次都超时 → 放弃，不再启动第三次', async () => {
  const kills = [];
  let launches = 0;
  const result = await runLaunchWatchdog({
    launch: () => {
      launches += 1;
      return fakeApp(launches, { kills });
    },
    probeReady: () => false,
    sleep,
    now: clocked(600),
    bootTimeoutMs: 1000,
    maxAttempts: 2,
    onFailure: async () => ({ ok: true, snapshotId: 'snap' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(launches, 2);
  assert.deepEqual(kills, [1, 2]);
  assert.equal(result.attempts.length, 2);
});

test('进程自己退出时不再 kill，但会回滚', async () => {
  const kills = [];
  let launches = 0;
  const result = await runLaunchWatchdog({
    launch: () => {
      launches += 1;
      const app = fakeApp(launches, { kills });
      app.setExited();
      return app;
    },
    probeReady: () => false,
    isExited: () => true,
    sleep,
    now: clocked(50),
    bootTimeoutMs: 1000,
    maxAttempts: 1,
    onFailure: async () => ({ ok: true, snapshotId: 'snap' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exited');
  assert.deepEqual(kills, [], '自己退出的进程不该再 kill');
  assert.equal(result.attempts[0].reason, 'exited');
  assert.equal(result.attempts[0].killed, false);
  assert.equal(result.attempts[0].restored.snapshotId, 'snap');
});

test('启动本身就抛异常时直接返回，不重试', async () => {
  let launches = 0;
  const result = await runLaunchWatchdog({
    launch: () => {
      launches += 1;
      throw new Error('ENOENT');
    },
    probeReady: () => false,
    sleep,
    now: clocked(10),
    bootTimeoutMs: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'launch-failed');
  assert.equal(launches, 1);
  assert.match(result.message, /ENOENT/);
});

test('回滚失败不会把看门狗本身弄崩', async () => {
  const result = await runLaunchWatchdog({
    launch: () => fakeApp(1, { kills: [] }),
    probeReady: () => false,
    sleep,
    now: clocked(600),
    bootTimeoutMs: 1000,
    maxAttempts: 1,
    onFailure: async () => {
      throw new Error('restore exploded');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts[0].restored.ok, false);
  assert.match(result.attempts[0].restored.message, /restore exploded/);
});

test('maxAttempts=1 时失败即返回', async () => {
  let launches = 0;
  const result = await runLaunchWatchdog({
    launch: () => {
      launches += 1;
      return fakeApp(launches, { kills: [] });
    },
    probeReady: () => false,
    sleep,
    now: clocked(600),
    bootTimeoutMs: 1000,
    maxAttempts: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(launches, 1);
});