import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { resolveLayout } from '../src/paths.mjs';
import { makeIo, removeDir, tempDir } from './helpers/fixture.mjs';

/**
 * Opt-in checks against the real ~/.dsh. They are skipped unless you set
 * DSH_REAL_HOME=1, because CI machines have no DSH install. Nothing here
 * writes to the real profile: the first test asserts that with file stats,
 * and the second only ever reads from it (everything else happens on a copy).
 */
const ENABLED = process.env.DSH_REAL_HOME === '1';
const SKIP = ENABLED ? false : '设置 DSH_REAL_HOME=1 才跑真实机器检查';

function realLayout() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return resolveLayout({ home, profile: process.env.DSH_REAL_PROFILE ?? 'desktop' });
}

function stats(layout) {
  const out = {};
  for (const spec of layout.stateFiles) {
    const target = path.join(layout.home, ...spec.rel.split('/'));
    try {
      const stat = fs.statSync(target);
      out[spec.rel] = { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      out[spec.rel] = null;
    }
  }
  return out;
}

test('真实 profile：只读体检不改动任何文件', { skip: SKIP }, () => {
  const layout = realLayout();
  const packagePath = path.join(layout.profileDir, 'package.json');
  if (!fs.existsSync(packagePath)) return;

  const before = stats(layout);
  const result = runDoctor({
    layout,
    runtimeVersion: process.env.DSH_REAL_RUNTIME ?? '0.2.1-rc.3',
  });
  const after = stats(layout);

  assert.deepEqual(after, before, '只读体检不能改动 profile');
  assert.ok(result.summary.bundles > 0, '真实 profile 至少有一个 bundle');
  assert.ok(result.summary.installed > 0, '真实 profile 的 node_modules 应该能扫到包');
  assert.ok(Array.isArray(result.findings));
});

test('真实配置的副本：good → 破坏 → rescue 逐字节还原', { skip: SKIP }, async (t) => {
  const source = realLayout();
  const packageSource = path.join(source.profileDir, 'package.json');
  if (!fs.existsSync(packageSource)) return;

  const home = tempDir('dsh-rescue-real-');
  t.after(() => removeDir(home));
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });

  const originalPackage = fs.readFileSync(packageSource, 'utf8');
  const patchSource = path.join(source.profileDir, 'cordis.patch.yml');
  const originalPatch = fs.existsSync(patchSource) ? fs.readFileSync(patchSource, 'utf8') : null;

  fs.writeFileSync(path.join(profileDir, 'package.json'), originalPackage);
  if (originalPatch !== null) fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), originalPatch);

  const capture = makeIo({ home });
  const goodCode = await runCli(['save', '--json'], capture.io);
  assert.equal(goodCode, 0, capture.stdout());
  const snapshotId = capture.json().id;

  // Break it the way a plugin fight would.
  const manifest = JSON.parse(originalPackage);
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.slice(0, 2);
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (originalPatch !== null) fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n');

  const capture2 = makeIo({ home });
  const restoredCode = await runCli(['restore', snapshotId, '--yes', '--json'], capture2.io);
  assert.equal(restoredCode, 0, capture2.stderr());
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), originalPackage);
  if (originalPatch !== null) {
    assert.equal(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), originalPatch);
  }
});