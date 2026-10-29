import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  checkPnpmStore,
  defaultStoreRoot,
  normalizeForCompare,
  readConfiguredStoreDir,
  resolveExpectedStore,
} from '../src/pnpmmeta.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { resolveLayout } from '../src/paths.mjs';
import { makeHome, removeDir, tempDir } from './helpers/fixture.mjs';

const WIN = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, homeDir: 'C:\\Users\\x' };
const LINUX = { platform: 'linux', env: { XDG_DATA_HOME: '/home/x/.local/share' }, homeDir: '/home/x' };

function writeMeta(home, meta) {
  fs.mkdirSync(path.join(home.profileDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(home.profileDir, 'node_modules', '.modules.yaml'), JSON.stringify(meta, null, 2));
}

const codes = (result) => result.findings.map((finding) => finding.code);

test('normalizeForCompare 把分隔符与大小写归一', () => {
  assert.equal(normalizeForCompare('D:\\DSH\\store\\v11', 'win32'), normalizeForCompare('d:/dsh/store/v11', 'win32'));
  assert.notEqual(normalizeForCompare('/a/b', 'linux'), normalizeForCompare('/a/c', 'linux'));
  assert.equal(normalizeForCompare('', 'linux'), '');
});

test('默认 store 根按平台走', () => {
  assert.equal(defaultStoreRoot(WIN), path.join('C:\\Users\\x\\AppData\\Local', 'pnpm', 'store'));
  assert.equal(defaultStoreRoot(LINUX), path.join('/home/x/.local/share', 'pnpm', 'store'));
});

test('storeDir 指向别的盘 → store.mismatch（当年的现场）', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeMeta(home, {
    storeDir: 'D:\\DSH\\pnpm-store\\v11',
    virtualStoreDir: path.join(home.profileDir, 'node_modules', '.pnpm'),
  });
  const result = checkPnpmStore({ profileDir: home.profileDir, ...WIN });
  assert.deepEqual(codes(result), ['store.mismatch']);
  assert.equal(result.findings[0].level, 'error');
  assert.ok(result.findings[0].message.includes('pnpm-store'), result.findings[0].message);
  assert.ok(result.findings[0].hint.includes('ERR_PNPM_UNEXPECTED_STORE'));
});

test('virtualStoreDir 指到别的 profile → store.virtualMismatch', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeMeta(home, {
    storeDir: path.join(defaultStoreRoot(WIN), 'v11'),
    virtualStoreDir: 'D:\\DSH\\profiles\\desktop\\node_modules\\.pnpm',
  });
  const result = checkPnpmStore({ profileDir: home.profileDir, ...WIN });
  assert.deepEqual(codes(result), ['store.virtualMismatch']);
});

test('两个都对时不报任何东西', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeMeta(home, {
    storeDir: path.join(defaultStoreRoot(WIN), 'v11'),
    virtualStoreDir: path.join(home.profileDir, 'node_modules', '.pnpm'),
  });
  assert.deepEqual(codes(checkPnpmStore({ profileDir: home.profileDir, ...WIN })), []);
});

test('pnpm 全局 config 里指定了 storeDir 时以它为准（不误报）', (t) => {
  const root = tempDir();
  t.after(() => removeDir(root));
  const localAppData = path.join(root, 'Local');
  fs.mkdirSync(path.join(localAppData, 'pnpm', 'config'), { recursive: true });
  fs.writeFileSync(path.join(localAppData, 'pnpm', 'config', 'config.yaml'), 'storeDir: D:/DSH/pnpm-store\n');
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeMeta(home, {
    storeDir: 'D:\\DSH\\pnpm-store\\v11',
    virtualStoreDir: path.join(home.profileDir, 'node_modules', '.pnpm'),
  });
  const opts = { platform: 'win32', env: { LOCALAPPDATA: localAppData }, homeDir: root };
  assert.equal(readConfiguredStoreDir(opts), 'D:/DSH/pnpm-store');
  assert.equal(resolveExpectedStore(opts).source, 'config');
  assert.deepEqual(codes(checkPnpmStore({ profileDir: home.profileDir, ...opts })), []);
});

test('--store 参数优先于 config', () => {
  assert.equal(resolveExpectedStore({ ...WIN, storeDir: 'E:\\custom\\store' }).source, 'flag');
});

test('没有 .modules.yaml 但 node_modules 在 → info', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  fs.mkdirSync(path.join(home.profileDir, 'node_modules', 'dsh-context'), { recursive: true });
  const result = checkPnpmStore({ profileDir: home.profileDir, ...WIN });
  assert.deepEqual(codes(result), ['store.meta.missing']);
  assert.equal(result.findings[0].level, 'info');
});

test('.modules.yaml 是坏 JSON → warn，不抛', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  fs.mkdirSync(path.join(home.profileDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(home.profileDir, 'node_modules', '.modules.yaml'), '{ broken');
  const result = checkPnpmStore({ profileDir: home.profileDir, ...WIN });
  assert.deepEqual(codes(result), ['store.meta.unreadable']);
});

test('两个字段都没有 → info（不猜）', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeMeta(home, { nodeLinker: 'hoisted' });
  assert.deepEqual(codes(checkPnpmStore({ profileDir: home.profileDir, ...WIN })), ['store.meta.incomplete']);
});

test('doctor 会把 store 问题算成 error（ok=false）', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeMeta(home, {
    storeDir: 'D:\\gone\\store\\v11',
    virtualStoreDir: path.join(home.profileDir, 'node_modules', '.pnpm'),
  });
  const layout = resolveLayout({ home: home.home });
  const result = runDoctor({ layout, runtimeVersion: '0.2.1-rc.3', storeDir: null, knownIds: { ids: [], complete: false } });
  const storeFindings = result.findings.filter((finding) => finding.code.startsWith('store.'));
  assert.equal(storeFindings.length, 1);
  assert.equal(storeFindings[0].level, 'error');
  assert.equal(result.ok, false);
});

test('doctor 在 store 一致时不受影响', (t) => {
  const home = makeHome();
  t.after(() => removeDir(home.home));
  writeMeta(home, {
    storeDir: path.join(defaultStoreRoot(), 'v11'),
    virtualStoreDir: path.join(home.profileDir, 'node_modules', '.pnpm'),
  });
  const layout = resolveLayout({ home: home.home });
  const result = runDoctor({ layout, runtimeVersion: '0.2.1-rc.3', knownIds: { ids: [], complete: false } });
  assert.deepEqual(result.findings.filter((finding) => finding.code.startsWith('store.')), []);
});