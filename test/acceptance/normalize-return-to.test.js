// Acceptance tests for normalizeReturnTo. Owner-authored and protected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReturnTo } from '../../src/normalize-return-to.js';

test('keeps same-origin paths', () => {
  for (const t of ['/', '/settings', '/a/b?c=d#e']) assert.equal(normalizeReturnTo(t), t);
});

test('replaces off-site and invalid targets with "/"', () => {
  for (const t of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', 'evil.example', '', null, undefined, 42, `/${'a'.repeat(2048)}`]) {
    assert.equal(normalizeReturnTo(t), '/', String(t).slice(0, 40));
  }
});
