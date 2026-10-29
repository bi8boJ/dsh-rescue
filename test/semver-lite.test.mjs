import assert from 'node:assert/strict';
import test from 'node:test';

import { compare, parse, satisfies } from '../src/semver-lite.mjs';

test('parse 接受常见写法，拒绝垃圾', () => {
  assert.deepEqual(parse('0.2.1-rc.3'), {
    major: 0,
    minor: 2,
    patch: 1,
    pre: ['rc', '3'],
    parts: 3,
    raw: '0.2.1-rc.3',
  });
  assert.equal(parse('v1.2.3').major, 1);
  assert.equal(parse('1.2').minor, 2);
  assert.equal(parse('1.2').parts, 2);
  assert.equal(parse('not-a-version'), null);
  assert.equal(parse(undefined), null);
});

test('compare 处理预发布顺序', () => {
  assert.equal(compare('0.2.1-rc.3', '0.2.1'), -1);
  assert.equal(compare('0.2.1', '0.2.1'), 0);
  assert.equal(compare('0.2.1-rc.3', '0.2.1-rc.2'), 1);
  assert.equal(compare('0.2.1-rc.10', '0.2.1-rc.9'), 1);
  assert.equal(compare('0.3.0', '0.2.9'), 1);
});

const CASES = [
  ['0.2.1-rc.3', '^0.2.0-rc.2', true],
  ['0.2.1-rc.3', '>=0.2.0-rc.2 <0.2.1', true],
  ['0.3.0', '^0.2.0', false],
  ['0.2.1', '^0.2.0', true],
  ['1.0.0', '*', true],
  ['1.0.0', 'x', true],
  ['1.0.0', '', true],
  ['0.1.2-rc.1', '0.1.2-rc.1', true],
  ['0.1.2-rc.2', '0.1.2-rc.1', false],
  ['1.2.9', '~1.2.3', true],
  ['1.3.0', '~1.2.3', false],
  ['3.0.0', '2.0.0 || 3.0.0', true],
  ['0.2.0', '^0.2.0-rc.2', true],
  ['1.2.5', '1.2.x', true],
  ['1.3.0', '1.2.x', false],
  ['1.9.0', '1.x', true],
  ['2.0.0', '1.2.3 - 2.0.0', true],
  ['2.0.1', '1.2.3 - 2.0.0', false],
  ['0.0.4', '^0.0.3', false],
  ['0.0.3', '^0.0.3', true],
];

for (const [version, range, expected] of CASES) {
  test(`satisfies(${version}, "${range}") === ${expected}`, () => {
    assert.equal(satisfies(version, range), expected);
  });
}

test('satisfies 对非法输入返回 false 而不是抛异常', () => {
  assert.equal(satisfies('garbage', '^1.0.0'), false);
  assert.equal(satisfies('1.0.0', '^^1'), false);
  assert.equal(satisfies(undefined, '^1.0.0'), false);
});