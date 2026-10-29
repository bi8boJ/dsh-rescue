import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzePatch,
  appendComment,
  appendDisable,
  formatDisableBlock,
  isEntryDisabled,
  isLayerDisabled,
} from '../src/yamlpatch.mjs';
import { DEFAULT_PATCH } from './helpers/fixture.mjs';

test('空文本与纯注释能被区分', () => {
  assert.equal(analyzePatch('').blank, true);
  assert.equal(analyzePatch('   \n\n').blank, true);
  const comments = analyzePatch('# 只有注释\n# 还是注释\n');
  assert.equal(comments.blank, false);
  assert.equal(comments.commentsOnly, true);
});

test('[] 是"停用整个补丁层"，不算空文件', () => {
  const info = analyzePatch('[]\n');
  assert.equal(info.blank, false);
  assert.equal(info.commentsOnly, false);
  assert.equal(info.entryCount, 0);
  assert.equal(info.layerDisabled, true);
  assert.equal(isLayerDisabled('[]\n'), true);
  assert.equal(isLayerDisabled('# 备注\n[]\n'), true);
  assert.equal(isLayerDisabled('- id: a\n'), false);
});

test('能数出条目与 id，并识别重复 id', () => {
  const info = analyzePatch(DEFAULT_PATCH);
  assert.equal(info.entryCount, 2);
  assert.deepEqual(info.ids, ['llm-pi-ai', 'compaction-basic']);
  assert.deepEqual(info.duplicates, []);
  assert.equal(info.hasTabIndent, false);

  const dup = analyzePatch('- id: a\n- id: a\n');
  assert.deepEqual(dup.duplicates, ['a']);
});

test('追加到空文件', () => {
  const result = appendDisable('', 'foo');
  assert.equal(result.changed, true);
  assert.equal(result.text, '- id: foo\n  disabled: true\n');
});

test('追加时原有字节一个不动（中文注释、!!js 都保留）', () => {
  const original = DEFAULT_PATCH;
  const result = appendDisable(original, 'new-entry');
  assert.equal(result.changed, true);
  assert.ok(result.text.startsWith(original), '原文本必须是新文本的前缀');
  assert.equal(result.text.slice(original.length), `\n${formatDisableBlock('new-entry')}\n`);
  assert.ok(result.text.includes('# 这行中文注释必须原样保留'));
});

test('CRLF 文件追加也用 CRLF', () => {
  const crlf = DEFAULT_PATCH.replace(/\n/g, '\r\n');
  const result = appendDisable(crlf, 'x');
  assert.ok(result.text.includes('\r\n- id: x\r\n  disabled: true\r\n'));
  assert.equal(result.text.replace(/\r\n/g, '').includes('\n'), false);
});

test('幂等：已经 disabled 的不再追加', () => {
  const first = appendDisable(DEFAULT_PATCH, 'foo');
  const second = appendDisable(first.text, 'foo');
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'already-disabled');
  assert.equal(second.text, first.text);
});

test('条目已存在但没 disabled 时不猜语义，原样返回', () => {
  const result = appendDisable(DEFAULT_PATCH, 'llm-pi-ai');
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'entry-exists');
  assert.equal(result.text, DEFAULT_PATCH);
});

test('往 [] 里追加会把 flow 序列换成 block 序列', () => {
  const result = appendDisable('[]\n', 'foo');
  assert.equal(result.changed, true);
  assert.equal(result.text, '- id: foo\n  disabled: true\n');
  assert.equal(isLayerDisabled(result.text), false);
});

test('[] 上面的注释在转换后仍然保留', () => {
  const result = appendDisable('# 先关掉整层\n[]\n', 'foo');
  assert.ok(result.text.startsWith('# 先关掉整层\n'));
  assert.ok(result.text.includes('- id: foo'));
  assert.ok(!result.text.includes('[]'));
});

test('isEntryDisabled 只看该条目自己的块', () => {
  const text = '- id: a\n  disabled: true\n- id: b\n  config:\n    x: 1\n';
  assert.equal(isEntryDisabled(text, 'a'), true);
  assert.equal(isEntryDisabled(text, 'b'), false);
  assert.equal(isEntryDisabled(text, 'missing'), false);
});

test('appendComment 追加注释块', () => {
  const result = appendComment('- id: a\n', '安全模式 2026-10-29');
  assert.ok(result.startsWith('- id: a\n'));
  assert.ok(result.includes('# 安全模式 2026-10-29'));
});

test('config 块里嵌套的 - id:（模型 id）不算补丁条目', () => {
  const text = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      aliyun:',
    '        models:',
    '          - id: qwen3.8-flash',
    '          - id: qwen3.8-max',
    '',
  ].join('\n');
  const info = analyzePatch(text);
  assert.deepEqual(info.ids, ['llm-pi-ai'], '只有根级列表项才是 entry');
  assert.equal(info.entryCount, 1);
  assert.equal(isEntryDisabled(text, 'qwen3.8-flash'), false);
  assert.equal(appendDisable(text, 'qwen3.8-flash').changed, true, '顶层的同名 entry 仍然是新条目');
});

test('id 不合法时抛错，不写坏文件', () => {
  assert.throws(() => appendDisable('', ''), /id is required/);
  assert.throws(() => appendDisable('', '   '), /id is required/);
});