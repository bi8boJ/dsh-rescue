import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { bundlesHash, beaconPath } from '../src/beacon.mjs';
import { resolveLayout } from '../src/paths.mjs';
import { makeHome, makeIo, readJsonFile, removeDir } from './helpers/fixture.mjs';

const NOT_RUNNING = () => ({ known: true, names: [] });

function writeBeaconFor(home, overrides = {}) {
  const layout = resolveLayout({ home: home.home });
  fs.mkdirSync(layout.rescueDir, { recursive: true });
  const bundles = readJsonFile(home.packageFile).dsh.profile.bundles;
  fs.writeFileSync(
    beaconPath(layout),
    JSON.stringify({
      version: 1,
      state: 'ok',
      bundlesHash: bundlesHash(bundles),
      bundlesCount: bundles.length,
      startedAt: '2026-10-29T10:00:00.000Z',
      readyAt: new Date().toISOString(),
      delayMs: 60000,
      ...overrides,
    }),
  );
}

test('good --auto 在有可信信标时直接标记', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeBeaconFor(home);

  const capture = makeIo({ home: home.home, detector: NOT_RUNNING });
  const code = await runCli(['good', '--auto', '--json'], capture.io);
  assert.equal(code, 0, capture.stderr());
  const payload = capture.json();
  assert.equal(payload.kind, 'good');
  assert.ok(payload.meta.runtimeVersion, '应记录运行时版本');
});

test('good --auto 没有信标时拒绝，并说明原因', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  const capture = makeIo({ home: home.home, detector: NOT_RUNNING });
  const code = await runCli(['good', '--auto', '--json'], capture.io);
  assert.equal(code, 1);
  const payload = capture.json();
  assert.equal(payload.reason, 'beacon-mismatch');
  assert.match(payload.why, /beacon\.json/);
});

test('good --auto 在信标仍是 booting 时拒绝', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeBeaconFor(home, { state: 'booting', readyAt: null });
  const capture = makeIo({ home: home.home, detector: NOT_RUNNING });
  const code = await runCli(['good', '--auto', '--json'], capture.io);
  assert.equal(code, 1);
  assert.match(capture.json().why, /booting/);
});

test('good --auto 在配置变过之后拒绝（哈希对不上）', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeBeaconFor(home, { bundlesHash: 'deadbeef' });
  const capture = makeIo({ home: home.home, detector: NOT_RUNNING });
  const code = await runCli(['good', '--auto', '--json'], capture.io);
  assert.equal(code, 1);
  assert.match(capture.json().why, /不一样/);
});

test('status 会带出信标信息', async (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeBeaconFor(home);
  const capture = makeIo({ home: home.home, detector: NOT_RUNNING });
  const code = await runCli(['status', '--json'], capture.io);
  assert.equal(code, 0);
  const payload = capture.json();
  assert.equal(payload.beacon.found, true);
  assert.equal(payload.beacon.hashMatches, true);
});