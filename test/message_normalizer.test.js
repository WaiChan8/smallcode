// SmallCode — message normalizer tests (issue #62)
//
// Strict chat templates (Qwen3/Qwen3.5 under llama.cpp --jinja) raise
// "System message must be at the beginning." and llama.cpp 400s when a
// system-role message appears anywhere but index 0 AND tools are present.
// consolidateSystemMessages() must guarantee exactly one leading system
// message.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { consolidateSystemMessages } = require('../src/session/message_normalizer');

test('merges a mid-conversation system message into the leading one', () => {
  const out = consolidateSystemMessages([
    { role: 'system', content: 'base prompt' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'system', content: 'PLAN: do the thing' },
    { role: 'user', content: 'go' },
  ]);
  // Exactly one system message, at index 0.
  assert.equal(out.filter(m => m.role === 'system').length, 1);
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /base prompt/);
  assert.match(out[0].content, /PLAN: do the thing/);
  // Non-system turns preserved in order.
  assert.deepEqual(out.slice(1).map(m => m.role), ['user', 'assistant', 'user']);
});

test('order of merged system parts is preserved', () => {
  const out = consolidateSystemMessages([
    { role: 'system', content: 'first' },
    { role: 'user', content: 'a' },
    { role: 'system', content: 'second' },
    { role: 'system', content: 'third' },
  ]);
  assert.equal(out[0].content, 'first\n\nsecond\n\nthird');
});

test('no system messages → array returned unchanged in content', () => {
  const input = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ];
  const out = consolidateSystemMessages(input);
  assert.deepEqual(out.map(m => m.role), ['user', 'assistant']);
});

test('idempotent on an already-normalized array', () => {
  const once = consolidateSystemMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u' },
  ]);
  const twice = consolidateSystemMessages(once);
  assert.deepEqual(twice, once);
});

test('deduplicates identical consecutive system blocks', () => {
  const out = consolidateSystemMessages([
    { role: 'system', content: 'same' },
    { role: 'user', content: 'u' },
    { role: 'system', content: 'same' },
  ]);
  assert.equal(out[0].content, 'same');
});

test('drops empty/whitespace-only system messages', () => {
  const out = consolidateSystemMessages([
    { role: 'system', content: 'real' },
    { role: 'system', content: '   ' },
    { role: 'user', content: 'u' },
  ]);
  assert.equal(out[0].content, 'real');
  assert.equal(out.filter(m => m.role === 'system').length, 1);
});

test('preserves multimodal user content untouched', () => {
  const img = { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:...' } }] };
  const out = consolidateSystemMessages([
    { role: 'system', content: 'sys' },
    img,
  ]);
  assert.equal(out[1], img); // same reference, unmodified
});

test('handles only-system input (collapses to one)', () => {
  const out = consolidateSystemMessages([
    { role: 'system', content: 'a' },
    { role: 'system', content: 'b' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'a\n\nb');
});

test('empty array is a no-op', () => {
  assert.deepEqual(consolidateSystemMessages([]), []);
});


// ─── Issue #49: recover a final answer from reasoning_content ───────────────

const { recoverReasoningAnswer } = require('../src/session/message_normalizer');

test('promotes reasoning_content to content when content is empty and no tool calls', () => {
  const msg = { role: 'assistant', content: '', reasoning_content: 'Here are the bugs I found: ...' };
  const promoted = recoverReasoningAnswer(msg);
  assert.equal(promoted, true);
  assert.equal(msg.content, 'Here are the bugs I found: ...');
});

test('does not touch content when it is already non-empty', () => {
  const msg = { role: 'assistant', content: 'real answer', reasoning_content: 'thinking...' };
  const promoted = recoverReasoningAnswer(msg);
  assert.equal(promoted, false);
  assert.equal(msg.content, 'real answer');
});

test('does not promote when there are tool calls', () => {
  const msg = {
    role: 'assistant',
    content: '',
    reasoning_content: 'I will read the file',
    tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  };
  const promoted = recoverReasoningAnswer(msg);
  assert.equal(promoted, false);
  assert.equal(msg.content, '');
});

test('no-op when reasoning_content is empty/whitespace', () => {
  const msg = { role: 'assistant', content: '', reasoning_content: '   ' };
  assert.equal(recoverReasoningAnswer(msg), false);
});

test('no-op when reasoning_content is absent', () => {
  const msg = { role: 'assistant', content: '' };
  assert.equal(recoverReasoningAnswer(msg), false);
});

test('handles null/garbage input safely', () => {
  assert.equal(recoverReasoningAnswer(null), false);
  assert.equal(recoverReasoningAnswer(undefined), false);
  assert.equal(recoverReasoningAnswer({}), false);
});
