// Acceptance tests for SPEC.md. Owner-authored and protected: a change to this folder stops the trial.
// They are skipped on branches that do not contain the module (for example the seeded branch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const file = new URL('../../src/is-safe-redirect.js', import.meta.url);
const present = existsSync(file);
const { isSafeRedirect } = present ? await import(file) : {};
const opts = { skip: present ? false : 'src/is-safe-redirect.js is not in this branch' };
const hosts = { allowedHosts: ['app.example'] };

test('accepts same-origin paths', opts, () => {
  for (const t of ['/', '/dashboard', '/a/b?c=d#e', '/search?q=%2F%2Fx']) assert.equal(isSafeRedirect(t), true, t);
});

test('rejects protocol-relative and backslash tricks', opts, () => {
  for (const t of ['//evil.example', '/\\evil.example', '\\\\evil.example', '/a\\b']) assert.equal(isSafeRedirect(t), false, t);
});

test('rejects control characters and whitespace', opts, () => {
  for (const t of ['/\t/evil.example', '/\n/evil.example', ' /x', '/x y']) assert.equal(isSafeRedirect(t), false, JSON.stringify(t));
});

test('accepts only allow-listed https hosts', opts, () => {
  assert.equal(isSafeRedirect('https://app.example/next', hosts), true);
  assert.equal(isSafeRedirect('https://APP.example/next', hosts), true);
  for (const t of ['https://evil.example/', 'http://app.example/', 'https://app.example.evil.example/', 'https://user:pw@app.example/', 'https://app.example:8443/']) {
    assert.equal(isSafeRedirect(t, hosts), false, t);
  }
  assert.equal(isSafeRedirect('https://app.example/next'), false, 'no hosts allowed by default');
});

test('rejects other schemes, non-strings and oversize input without throwing', opts, () => {
  for (const t of ['javascript:alert(1)', 'data:text/html,x', '', null, undefined, 42, {}, `/${'a'.repeat(2048)}`]) {
    assert.equal(isSafeRedirect(t, hosts), false, String(t).slice(0, 40));
  }
});
