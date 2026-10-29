import assert from 'node:assert/strict';
import test from 'node:test';

import { runBisect } from '../src/bisect.mjs';

const BUNDLES = ['@deepseek-ai/dsh-base', 'alpha', 'beta', 'gamma', 'delta'];

function bootsWithout(culprits, calls) {
  return async (members) => {
    calls.push(members.slice());
    return !members.some((name) => culprits.includes(name));
  };
}

test('二分能定位到唯一元凶', async () => {
  const calls = [];
  const result = await runBisect({
    bundles: BUNDLES,
    isCandidate: (name) => name !== '@deepseek-ai/dsh-base',
    test: bootsWithout(['beta'], calls),
  });
  assert.equal(result.ok, true);
  assert.equal(result.culprit, 'beta');
  assert.deepEqual(result.candidates, ['alpha', 'beta', 'gamma', 'delta']);
  assert.equal(result.rounds[0].phase, 'baseline-full');
  assert.equal(result.rounds[1].phase, 'control-bare');
  assert.ok(result.rounds.some((round) => round.phase === 'bisect'));
  assert.ok(calls.length <= Math.ceil(Math.log2(4)) + 3, `轮数 ${calls.length} 太多`);
});

test('每个候选都试一遍也能收敛（最坏情况）', async () => {
  for (const culprit of ['alpha', 'beta', 'gamma', 'delta']) {
    const result = await runBisect({
      bundles: BUNDLES,
      isCandidate: (name) => name !== '@deepseek-ai/dsh-base',
      test: bootsWithout([culprit], []),
    });
    assert.equal(result.ok, true, culprit);
    assert.equal(result.culprit, culprit);
  }
});

test('起点就是好的 → 不二分，并说明原因', async () => {
  const result = await runBisect({
    bundles: BUNDLES,
    isCandidate: (name) => name !== '@deepseek-ai/dsh-base',
    test: async () => true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'baseline-boots');
  assert.equal(result.rounds.length, 1);
});

test('全关掉第三方也起不来 → 判定不是插件的问题', async () => {
  const result = await runBisect({
    bundles: BUNDLES,
    isCandidate: (name) => name !== '@deepseek-ai/dsh-base',
    test: async () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'without-candidates-also-fails');
  assert.equal(result.rounds.at(-1).phase, 'control-bare');
});

test('候选少于两个时直接说没得二分', async () => {
  const result = await runBisect({
    bundles: ['@deepseek-ai/dsh-base', 'only'],
    isCandidate: (name) => name !== '@deepseek-ai/dsh-base',
    test: async () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-few-candidates');
  assert.deepEqual(result.rounds, []);
});

test('maxRounds 用尽时如实报告，而不是死循环', async () => {
  const result = await runBisect({
    bundles: BUNDLES,
    isCandidate: (name) => name !== '@deepseek-ai/dsh-base',
    test: bootsWithout(['beta'], []),
    maxRounds: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'round-limit');
});

test('test 抛异常时向上抛，不吞掉', async () => {
  await assert.rejects(
    runBisect({
      bundles: BUNDLES,
      isCandidate: (name) => name !== '@deepseek-ai/dsh-base',
      test: async () => {
        throw new Error('boom');
      },
    }),
    /boom/,
  );
});

test('没有候选时不做任何调用', async () => {
  let calls = 0;
  const result = await runBisect({
    bundles: ['@deepseek-ai/dsh-base'],
    isCandidate: (name) => name !== '@deepseek-ai/dsh-base',
    test: async () => {
      calls += 1;
      return true;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});