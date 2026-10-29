import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appListeningPorts,
  isAppReady,
  parseListening,
  parseProcessTable,
  listListening,
  processTable,
} from '../src/netprobe.mjs';

const NETSTAT = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2360
  TCP    127.0.0.1:49862        0.0.0.0:0              LISTENING       2740
  TCP    127.0.0.1:49862        127.0.0.1:50194        ESTABLISHED     2740
  TCP    127.0.0.1:14013        0.0.0.0:0              LISTENING       28564
  TCP    [::1]:9229             [::]:0                 LISTENING       9001
  UDP    0.0.0.0:500             *:*                                    1234
`;

const TASKLIST = `"DeepSeek Harness.exe","2740","Console","1","100,000 K"
"DeepSeek Harness.exe","28564","Console","1","80,000 K"
"node.exe","9001","Console","1","20,000 K"
"chrome.exe","2360","Console","1","60,000 K"
`;

function fakeExec(tables) {
  return (file) => {
    if (file === 'netstat') return NETSTAT;
    if (file === 'tasklist') return TASKLIST;
    if (file === 'ps') return '2740 DeepSeek Harness\n9001 node\n';
    return tables?.[file] ?? '';
  };
}

test('解析 netstat：只保留 TCP 的 LISTEN 行，并标出 loopback', () => {
  const rows = parseListening(NETSTAT);
  assert.equal(rows.length, 4, JSON.stringify(rows));
  const loopback = rows.filter((row) => row.loopback);
  assert.deepEqual(loopback.map((row) => row.port).sort((a, b) => a - b), [9229, 14013, 49862]);
  assert.ok(rows.every((row) => row.pid > 0));
  const wildcard = rows.find((row) => row.port === 135);
  assert.equal(wildcard.loopback, false);
});

test('解析 tasklist CSV 与 ps 输出', () => {
  const win = parseProcessTable(TASKLIST, 'win32');
  assert.equal(win.get(2740), 'DeepSeek Harness.exe');
  assert.equal(win.get(2360), 'chrome.exe');

  const posix = parseProcessTable('2740 DeepSeek Harness\n9001 node\n', 'linux');
  assert.equal(posix.get(2740), 'DeepSeek Harness');
  assert.equal(posix.get(9001), 'node');
});

test('DSH 图像名在 loopback 上监听 → 判定已就绪', () => {
  assert.equal(isAppReady({ exeName: 'DeepSeek Harness.exe', exec: fakeExec(), platform: 'win32' }), true);
});

test('没有 DSH 进程在听 → 未就绪', () => {
  assert.equal(isAppReady({ exeName: 'DSH NEXT.exe', exec: fakeExec(), platform: 'win32' }), false);
  assert.equal(isAppReady({ exeName: '', exec: fakeExec(), platform: 'win32' }), false);
});

test('只有别的进程在听 → 未就绪（不能把别人的端口当就绪）', () => {
  const exec = (file) => {
    if (file === 'netstat') return '  TCP    127.0.0.1:49862    0.0.0.0:0    LISTENING    4242\n';
    if (file === 'tasklist') return '"other.exe","4242","Console","1","1 K"\n';
    return '';
  };
  assert.equal(isAppReady({ exeName: 'DeepSeek Harness.exe', exec, platform: 'win32' }), false);
});

test('netstat / tasklist 失败时安全返回空', () => {
  const exec = () => {
    throw new Error('nope');
  };
  assert.deepEqual(listListening({ exec, platform: 'win32' }), []);
  assert.equal(processTable({ exec, platform: 'win32' }).size, 0);
  assert.equal(isAppReady({ exeName: 'DeepSeek Harness.exe', exec, platform: 'win32' }), false);
});

test('appListeningPorts 只报该应用拥有的端口', () => {
  const ports = appListeningPorts({ exeName: 'DeepSeek Harness.exe', exec: fakeExec(), platform: 'win32' });
  assert.deepEqual(ports.sort((a, b) => a - b), [14013, 49862]);
});