// Offline checks of the coordinator's decisions (no network). Run: node --test .github/vanta/coordinator.check.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, classifyFire, countFindings, decide, fireDecision, ledgerDescription, parseLedger } from './coordinator.mjs';

const T0 = Date.parse('2026-11-20T10:00:00Z');
const min = (n) => n * 60_000;
const att = (a, state, t, extra = {}) => ({ a, state, t, h: null, code: null, retryAfter: null, ...extra });
const pr = (over = {}) => ({ number: 7, state: 'open', headRef: 'claude/is-safe-redirect', headSha: 'aaaaaaa111', createdAt: T0 + min(20), labels: [], isDevelop: true, isSeed: false, ci: 'pass', guard: 'pass', ciDoneAt: T0 + min(30), review: { id: 1, via: 'review', findings: 0 }, ...over });
const base = (over = {}) => ({ now: T0, action: 'tick', armed: true, runId: 'run1', fireConfigured: true, ledger: new Map(), prs: [], tripwire: [], ...over });
const L = (obj) => new Map(Object.entries(obj));

test('start results: only 2xx with a session id counts as launched; timeouts and 5xx are unknown, never "not started"', () => {
  assert.equal(classifyFire(200, { claude_code_session_id: 's1', claude_code_session_url: 'https://claude.ai/code/s1' }).outcome, 'launched');
  assert.equal(classifyFire(200, {}).outcome, 'unknown');
  for (const c of [400, 401, 403, 404, 429]) assert.equal(classifyFire(c, null).outcome, 'not_started', String(c));
  for (const c of [500, 502, 503, 0]) assert.equal(classifyFire(c, null).outcome, 'unknown', String(c));
  assert.equal(classifyFire(200, { claude_code_session_id: 's', claude_code_session_url: 'https://evil.example/' }).url, undefined);
});

test('an unknown start is never retried: wait, then block for the owner', () => {
  const a = [att(1, 'unknown', T0)];
  assert.equal(fireDecision(a, false, T0 + min(10)).do, 'wait');
  assert.equal(fireDecision(a, false, T0 + LIMITS.stallMs + 1).do, 'block');
  assert.equal(fireDecision(a, true, T0 + min(10)).do, 'none', 'progress settles it');
});

test('a stalled session is started again once, only after a full usage window, then blocked', () => {
  const one = [att(1, 'launched', T0)];
  assert.equal(fireDecision(one, false, T0 + min(30)).do, 'wait');
  assert.equal(fireDecision(one, false, T0 + min(120)).do, 'wait', 'waiting for capacity');
  assert.deepEqual(fireDecision(one, false, T0 + LIMITS.capacityRetryMs), { do: 'fire', a: 2 });
  const two = [...one, att(2, 'launched', T0 + LIMITS.capacityRetryMs)];
  assert.equal(fireDecision(two, false, T0 + LIMITS.capacityRetryMs + LIMITS.stallMs + 1).do, 'block');
});

test('definite refusals: paused (400) retries on the next tick, 429 waits for Retry-After, 401/403/404 block', () => {
  assert.equal(fireDecision([att(1, 'not_started', T0, { code: 400 })], false, T0 + min(10)).do, 'fire');
  assert.equal(fireDecision([att(1, 'not_started', T0, { code: 429, retryAfter: 600 })], false, T0 + min(5)).do, 'wait');
  assert.equal(fireDecision([att(1, 'not_started', T0, { code: 429, retryAfter: 600 })], false, T0 + min(11)).do, 'fire');
  for (const code of [401, 403, 404]) assert.equal(fireDecision([att(1, 'not_started', T0, { code })], false, T0 + min(10)).do, 'block');
});

test('ledger: only github-actions statuses for this run count; a leftover "pending" reads as unknown', () => {
  const st = (context, state, d, at, login = 'github-actions[bot]') => ({ context, state, description: JSON.stringify(d), created_at: new Date(at).toISOString(), creator: { login } });
  const statuses = [
    st('vanta-ledger/run1/develop', 'pending', { a: 2 }, T0 + 2),
    st('vanta-ledger/run1/develop', 'failure', { a: 1, c: 400 }, T0 + 1),
    st('vanta-ledger/run1/develop', 'pending', { a: 1 }, T0),
    st('vanta-ledger/run1/develop', 'success', { a: 3 }, T0 + 3, 'Antz-112'), // not written by a workflow: ignored
    st('vanta-ledger/drill/develop', 'success', { a: 1 }, T0), // other run id: ignored
  ]; // newest first, as GitHub returns them
  const dev = parseLedger(statuses, 'run1').get('develop');
  assert.deepEqual(dev.map((x) => [x.a, x.state, x.code]), [[1, 'not_started', 400], [2, 'unknown', null]]);
});

test('ledger descriptions always stay valid JSON within 140 characters', () => {
  const s = ledgerDescription({ a: 1, n: 'x"\\'.repeat(80) });
  assert.ok(s.length <= 140);
  assert.doesNotThrow(() => JSON.parse(s));
});

test('not armed: nothing is started, even with the trigger configured', () => {
  const out = decide(base({ armed: false }));
  assert.equal(out.fires.length, 0);
});

test('armed: exactly one develop start, then none while it runs', () => {
  assert.deepEqual(decide(base()).fires.map((f) => f.key), ['develop']);
  const running = decide(base({ now: T0 + min(10), ledger: L({ develop: [att(1, 'launched', T0)] }) }));
  assert.equal(running.fires.length, 0);
});

test('drill fires once per run id, payload VANTA-DRILL, and never when stopped', () => {
  const d = decide(base({ armed: false, action: 'drill' }));
  assert.deepEqual(d.fires.map((f) => f.payload), ['VANTA-DRILL']);
  assert.equal(decide(base({ armed: false, action: 'drill', ledger: L({ drill: [att(1, 'not_started', T0, { code: 400 })] }) })).fires.length, 0);
  assert.equal(decide(base({ armed: false, action: 'drill', ledger: L({ stop: [att(1, 'launched', T0)] }) })).fires.length, 0);
});

test('STOP label: records a permanent stop, closes every open trial PR, reports once, starts nothing', () => {
  const out = decide(base({ prs: [pr({ labels: ['vanta:stop'] }), pr({ number: 8, isSeed: true, isDevelop: false })] }));
  assert.equal(out.fires.length, 0);
  assert.ok(out.ops.some((o) => o.op === 'ledger' && o.key === 'stop'));
  assert.deepEqual(out.ops.filter((o) => o.op === 'close').map((o) => o.pr), [7, 8]);
  const later = decide(base({ ledger: L({ stop: [att(1, 'launched', T0, { note: 'STOP label' })], 'pr7-report': [att(1, 'launched', T0)], 'pr8-report': [att(1, 'launched', T0)] }), prs: [] }));
  assert.equal(later.ops.length, 0, 'no repeated reports; removing the label changes nothing');
});

test('tripwire: a protected-path commit on any branch stops the run', () => {
  const out = decide(base({ tripwire: [{ sha: 'bbbbbbb', path: '.github/workflows/ci.yml' }] }));
  assert.equal(out.fires.length, 0);
  assert.match(out.ops.find((o) => o.key === 'stop').d.n, /protected path/);
});

test('repair rounds: findings start round 1, a repaired head starts round 2, a third need is blocked and closed', () => {
  const dev = { develop: [att(1, 'launched', T0)] };
  const r1 = decide(base({ now: T0 + min(40), ledger: L(dev), prs: [pr({ review: { id: 1, via: 'review', findings: 1 } })] }));
  assert.deepEqual(r1.fires.map((f) => [f.key, f.h]), [['pr7-r1', 'aaaaaaa']]);
  // Same head, round 1 already started: no duplicate start.
  const again = decide(base({ now: T0 + min(45), ledger: L({ ...dev, 'pr7-r1': [att(1, 'launched', T0 + min(40), { h: 'aaaaaaa' })] }), prs: [pr({ review: { id: 1, via: 'review', findings: 1 } })] }));
  assert.equal(again.fires.length, 0);
  const r2 = decide(base({ now: T0 + min(90), ledger: L({ ...dev, 'pr7-r1': [att(1, 'launched', T0 + min(40), { h: 'aaaaaaa' })] }), prs: [pr({ headSha: 'ccccccc222', ci: 'fail', review: { id: 2, via: 'review', findings: 0 } })] }));
  assert.deepEqual(r2.fires.map((f) => f.key), ['pr7-r2']);
  const r3 = decide(base({ now: T0 + min(150), ledger: L({ ...dev, 'pr7-r1': [att(1, 'launched', T0, { h: 'aaaaaaa' })], 'pr7-r2': [att(1, 'launched', T0, { h: 'ccccccc' })] }), prs: [pr({ headSha: 'ddddddd333', review: { id: 3, via: 'review', findings: 2 } })] }));
  assert.equal(r3.fires.length, 0);
  assert.ok(r3.ops.some((o) => o.op === 'close' && o.pr === 7));
  assert.ok(r3.ops.some((o) => o.op === 'report' && /repair limit/.test(o.outcome)));
});

test('verified only with CI passing and a clean Codex review of the exact head', () => {
  const out = decide(base({ now: T0 + min(40), ledger: L({ develop: [att(1, 'launched', T0)] }), prs: [pr()] }));
  assert.ok(out.ops.some((o) => o.op === 'label' && o.label === 'vanta:verified'));
  const waiting = decide(base({ now: T0 + min(40), ledger: L({ develop: [att(1, 'launched', T0)] }), prs: [pr({ ci: 'pending', review: null })] }));
  assert.equal(waiting.ops.length, 0);
});

test('missing review: one "@codex review" request after 30 minutes, then blocked', () => {
  const ledger = { develop: [att(1, 'launched', T0)] };
  const p = pr({ review: null, ciDoneAt: T0 + min(30) });
  assert.equal(decide(base({ now: T0 + min(40), ledger: L(ledger), prs: [p] })).ops.length, 0);
  const ask = decide(base({ now: T0 + min(61), ledger: L(ledger), prs: [p] }));
  assert.ok(ask.ops.some((o) => o.op === 'comment' && o.body === '@codex review'));
  const blocked = decide(base({ now: T0 + min(95), ledger: L({ ...ledger, 'pr7-reviewreq-aaaaaaa': [att(1, 'launched', T0 + min(61))] }), prs: [p] }));
  assert.ok(blocked.ops.some((o) => o.op === 'label' && o.label === 'vanta:blocked'));
});

test('deadline: no new starts 8 hours after the first start', () => {
  const out = decide(base({ now: T0 + LIMITS.deadlineMs + 1, ledger: L({ develop: [att(1, 'launched', T0)] }) }));
  assert.equal(out.fires.length, 0);
  assert.match(out.ops.find((o) => o.key === 'stop').d.n, /deadline/);
});

test('hard ceiling on sessions: 2 per develop step, 2 per repair round, 2 rounds per PR', () => {
  assert.equal(LIMITS.maxSessionsPerKey, 2);
  assert.equal(LIMITS.maxRepairRounds, 2);
});

test('findings count P0/P1 markers only', () => {
  assert.equal(countFindings(['![P1 Badge] Open redirect', 'nit: naming', '**P0** crash']), 2);
});
