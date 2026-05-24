// Regression tests for normalizeBaseUrl — closes issue #44.
//
// The bug: SMALLCODE_BASE_URL=http://localhost:11434 (no /v1) hit Ollama's
// native /api endpoint while config.js still routed through the OpenAI-
// compatible path, calling ${baseUrl}/models — which is a 404 on Ollama.
// Result: "Cannot reach endpoint at http://localhost:11434" even though
// Ollama was running.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeBaseUrl } = require('../bin/config');

test('Ollama bare host gets /v1 appended', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434'), 'http://localhost:11434/v1');
});

test('LM Studio bare host gets /v1 appended', () => {
  assert.equal(normalizeBaseUrl('http://localhost:1234'), 'http://localhost:1234/v1');
});

test('llama.cpp bare host gets /v1 appended', () => {
  assert.equal(normalizeBaseUrl('http://localhost:8080'), 'http://localhost:8080/v1');
});

test('URLs that already contain /v1 are left alone', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('http://localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
});

test('Native Ollama /api paths are NOT rewritten', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/api'), 'http://localhost:11434/api');
  assert.equal(normalizeBaseUrl('http://localhost:11434/api/tags'), 'http://localhost:11434/api/tags');
});

test('Trailing slashes are stripped', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('http://localhost:11434//'), 'http://localhost:11434/v1');
});

test('Unknown ports without /v1 are left alone', () => {
  // We only auto-append /v1 for ports we know speak OpenAI-compat. A custom
  // proxy on port 9000 might be using a non-standard path.
  assert.equal(normalizeBaseUrl('http://localhost:9000'), 'http://localhost:9000');
  assert.equal(normalizeBaseUrl('https://my-proxy.example.com'), 'https://my-proxy.example.com');
});

test('URL with custom path is left alone', () => {
  // User intentionally pointed at a non-/v1 path — respect it.
  assert.equal(normalizeBaseUrl('http://localhost:11434/openai'), 'http://localhost:11434/openai');
  assert.equal(normalizeBaseUrl('http://localhost:1234/custom'), 'http://localhost:1234/custom');
});

test('Empty / falsy input is returned unchanged', () => {
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl(null), null);
  assert.equal(normalizeBaseUrl(undefined), undefined);
});

test('Malformed URL is returned unchanged (no throw)', () => {
  assert.equal(normalizeBaseUrl('not-a-url'), 'not-a-url');
});
