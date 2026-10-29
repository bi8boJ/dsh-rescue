import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { SHIPPED_BUNDLES, makeHome, makeIo, removeDir, tempDir } from './helpers/fixture.mjs';

const NOT_RUNNING = () => ({ known: true, names: [] });

function fakeApp(root) {
  const appDir = path.join(root, 'DeepSeek Harness');
  fs.mkdirSync(appDir, { recursive: true });
  const exe = path.join(appDir, 'DeepSeek Harness.exe');
  fs.writeFileSync(exe, 'stub');
  return exe;
}

function fakeChild(pid) {
  return {
    pid,
    handlers: {},
    once(event, callback) {
      this.handlers[event] = callback;
    },
    unref() {},
  };
}

function clocked(step) {
  let value = 0;
  return () => {
    value += step;
    return value;
  };
}

function bundlesOf(home) {
  return JSON.parse(fs.readFileSync(home.packageFile, 'utf8')).dsh.profile.bundles;
}

/** Boots unless the culprit is loaded — decided by reading the fixture, like the real probe. */
function probeFromProfile(home, culprit) {
  return () => {
    const bundles = bundlesOf(home);
    return !bundles.includes(culprit);
  };
}

test('bisect 找出元凶、跑完还原配置、退出码 0', async (t) => {
  const home = makeHome({
    bundles: [...SHIPPED_BUNDLES, 'alpha', 'culprit-b', 'gamma'],
    deps: { alpha: '^1.0.0', 'culprit-b': '^1.0.0', gamma: '^1.0.0' },
  });
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);
  const original = bundlesOf(home);
  const kills = [];

  const capture = makeIo({
    home: home.home,
    detector: NOT_RUNNING,
    spawn: () => fakeChild(5000 + kills.length),
    exec: (file, args) => {
      kills.push([file, ...args]);
      return '';
    },
    probe: probeFromProfile(home, 'culprit-b'),
    sleep: async () => {},
    now: clocked(70_000),
  });

  const code = await runCli(['bisect', '--yes', '--json', '--app', exe], capture.io);
  assert.equal(code, 0, capture.stderr());
  const payload = capture.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.culprit, 'culprit-b');
  assert.equal(payload.reason, 'found');
  assert.ok(payload.rounds >= 2);
  assert.deepEqual(bundlesOf(home), original, '跑完必须还原成原来的 bundles');
});

test('bisect 在基线本来就起得来时如实说明', async (t) => {
  const home = makeHome({
    bundles: [...SHIPPED_BUNDLES, 'alpha', 'beta'],
    deps: { alpha: '^1.0.0', beta: '^1.0.0' },
  });
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);
  const original = bundlesOf(home);

  const capture = makeIo({
    home: home.home,
    detector: NOT_RUNNING,
    spawn: () => fakeChild(6001),
    exec: () => '',
    probe: () => true,
    sleep: async () => {},
    now: clocked(1000),
  });

  const code = await runCli(['bisect', '--yes', '--json', '--app', exe], capture.io);
  assert.equal(code, 1);
  assert.equal(capture.json().reason, 'baseline-boots');
  assert.deepEqual(bundlesOf(home), original);
});

test('bisect 在没有实例可启动时会拒绝（DSH 开着）', async (t) => {
  const home = makeHome();
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);
  const capture = makeIo({ home: home.home, detector: () => ({ known: true, names: ['DeepSeek Harness.exe'] }) });
  const code = await runCli(['bisect', '--json', '--app', exe], capture.io);
  assert.equal(code, 1);
  assert.equal(capture.json().reason, 'already-running');
});

test('bisect --dry-run 只打印计划', async (t) => {
  const home = makeHome({
    bundles: [...SHIPPED_BUNDLES, 'alpha', 'beta'],
    deps: { alpha: '^1.0.0', beta: '^1.0.0' },
  });
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);
  const capture = makeIo({ home: home.home, detector: NOT_RUNNING });
  const code = await runCli(['bisect', '--dry-run', '--json', '--app', exe], capture.io);
  assert.equal(code, 0);
  const payload = capture.json();
  assert.equal(payload.dryRun, true);
  assert.deepEqual(payload.suspects, ['alpha', 'beta']);
  assert.equal(payload.roundSeconds, 60);
});

test('候选不足两个时给出明确原因', async (t) => {
  const home = makeHome({ bundles: [...SHIPPED_BUNDLES, 'alpha'], deps: { alpha: '^1.0.0' } });
  const root = tempDir();
  t.after(() => {
    removeDir(home.home);
    removeDir(root);
  });
  const exe = fakeApp(root);
  const capture = makeIo({ home: home.home, detector: NOT_RUNNING });
  const code = await runCli(['bisect', '--yes', '--json', '--app', exe], capture.io);
  assert.equal(code, 1);
  assert.equal(capture.json().reason, 'too-few-candidates');
});