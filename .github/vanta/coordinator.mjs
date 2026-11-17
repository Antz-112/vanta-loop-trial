// VANTA trial coordinator. Deterministic: no model, no pull-request code. Runs from main only.
//
// Ledger: append-only GitHub commit statuses on one fixed setup commit (config.ledgerSha).
// Statuses cannot be deleted, and the Claude and Codex apps have only read access to them,
// so only this repository's workflows can write the ledger. A workflow change on any branch
// trips the protected-path tripwire, which stops the run for good.
//
// Task starts have no idempotency key, so every start is written to the ledger as "pending"
// BEFORE the HTTP call, then resolved:
//   launched     2xx with a session id
//   not_started  documented refusal (400, 401, 403, 404, 429): nothing started
//   unknown      timeout, network error, 5xx or no session id: a session MAY exist
// An unknown result is never retried. A launched session with no visible progress is retried
// at most once more after 5 hours (in case it stopped at a usage limit), then the key is blocked.
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { ACTIONS_BOT, CODEX_BOT, github, loadConfig, protectedChanges } from './lib.mjs';

const MIN = 60_000;
export const LIMITS = Object.freeze({
  maxRepairRounds: 2, // repair sessions are started for at most 2 rounds per pull request
  maxSessionsPerKey: 2, // at most 2 possibly-started sessions for one develop step or one repair round
  stallMs: 60 * MIN, // launched, but no push or pull request after this long
  capacityRetryMs: 300 * MIN, // wait 5 hours (one usage window) before starting again
  reviewWaitMs: 30 * MIN, // CI finished, but no Codex review after this long
  deadlineMs: 8 * 60 * MIN, // no new starts after this long from the first start
  maxNonStarts: 100, // definite refusals (task paused, rate limit) per key
});
const FIRE_URL_RE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/[\w-]+\/fire$/;
const KNOWN_REFUSALS = new Set([400, 401, 403, 404, 429]);

export function classifyFire(status, body, retryAfter) {
  if (status >= 200 && status < 300) {
    const sid = body?.claude_code_session_id;
    const url = body?.claude_code_session_url;
    return sid
      ? { outcome: 'launched', code: status, sid, url: /^https:\/\/claude\.ai\//.test(url ?? '') ? url : undefined }
      : { outcome: 'unknown', code: status, note: 'no session id' };
  }
  if (KNOWN_REFUSALS.has(status)) return { outcome: 'not_started', code: status, retryAfter: Number(retryAfter) || undefined };
  return { outcome: 'unknown', code: status };
}

/** Ledger keys → attempts. GitHub lists statuses newest first. */
export function parseLedger(statuses, runId) {
  const prefix = `vanta-ledger/${runId}/`;
  const byKey = new Map();
  for (const st of [...statuses].reverse()) {
    if (st.creator?.login !== ACTIONS_BOT || !st.context?.startsWith(prefix)) continue;
    let d;
    try {
      d = JSON.parse(st.description || '{}');
    } catch {
      d = { n: 'unparsable ledger entry' }; // still counts: a key is never forgotten
    }
    const key = st.context.slice(prefix.length);
    if (!byKey.has(key)) byKey.set(key, []);
    const list = byKey.get(key);
    const a = Number(d.a) || 1;
    let att = list.find((x) => x.a === a);
    if (!att) list.push((att = { a, t: Date.parse(st.created_at), h: d.h ?? null }));
    // A "pending" still showing in a later run means that run ended mid-call: treat it as unknown.
    att.state = { success: 'launched', failure: 'not_started' }[st.state] ?? 'unknown';
    att.code = d.c ?? null;
    att.retryAfter = d.r ?? null;
    att.note = d.n ?? null;
    if (st.target_url) att.url = st.target_url;
  }
  return byKey;
}

/** Whether to start (again) the session for one key. */
export function fireDecision(attempts, progressed, now) {
  if (progressed) return { do: 'none', why: 'progressed' };
  const last = attempts.at(-1);
  if (!last) return { do: 'fire', a: 1 };
  const sessions = attempts.filter((x) => x.state !== 'not_started').length;
  if (last.state === 'unknown') {
    return now - last.t > LIMITS.stallMs
      ? { do: 'block', why: 'start result unknown and no progress: check the task history at claude.ai/code/routines' }
      : { do: 'wait', why: 'start result unknown: waiting for evidence, not retrying' };
  }
  if (last.state === 'launched') {
    if (now - last.t < LIMITS.stallMs) return { do: 'wait', why: 'session running' };
    if (sessions >= LIMITS.maxSessionsPerKey) return { do: 'block', why: `no progress after ${sessions} session(s)` };
    if (now - last.t < LIMITS.capacityRetryMs) return { do: 'wait', why: 'waiting for capacity: session made no progress' };
    return { do: 'fire', a: attempts.length + 1 };
  }
  // Definite refusal: nothing started.
  if (attempts.length - sessions >= LIMITS.maxNonStarts) return { do: 'block', why: 'too many refused starts' };
  if ([401, 403, 404].includes(last.code)) return { do: 'block', why: `task start refused (${last.code}): check the task, its token and URL` };
  if (last.code === 429 && last.retryAfter && now < last.t + last.retryAfter * 1000) return { do: 'wait', why: 'rate limited' };
  return { do: 'fire', a: attempts.length + 1, why: last.code === 400 ? 'retry after refusal (task paused?)' : 'retry after refusal' };
}

export function countFindings(texts) {
  return texts.filter((t) => /\bP[01]\b/.test(t ?? '')).length;
}

const firstStart = (L) =>
  Math.min(...[...L].filter(([k]) => k === 'develop' || /^pr\d+-r\d+$/.test(k)).flatMap(([, at]) => at.filter((x) => x.state !== 'not_started').map((x) => x.t)), Infinity);

/** Pure decision for one tick. */
export function decide(s) {
  const L = s.ledger;
  const has = (k) => (L.get(k) ?? []).length > 0;
  const out = { fires: [], ops: [], log: [] };
  const open = s.prs.filter((p) => p.state === 'open');

  let reason = has('stop') ? (L.get('stop')[0].note ?? 'stopped') : null;
  if (!reason) {
    if (s.tripwire.length) reason = `protected path changed (${s.tripwire.map((h) => `${h.sha.slice(0, 7)} ${h.path}`).join(', ')})`;
    else if (s.action === 'stop') reason = 'STOP requested (workflow dispatch)';
    else if (open.some((p) => p.labels.includes('vanta:stop'))) reason = 'STOP label';
    else if (s.now - firstStart(L) > LIMITS.deadlineMs) reason = 'run deadline reached';
    if (reason) out.ops.push({ op: 'ledger', key: 'stop', state: 'success', d: { n: reason.slice(0, 90) } });
  }
  if (reason) {
    out.log.push(`STOPPED: ${reason}`);
    for (const p of open) out.ops.push({ op: 'close', pr: p.number });
    for (const p of open) if (!has(`pr${p.number}-report`)) out.ops.push({ op: 'report', pr: p.number, dev: p.isDevelop, outcome: `stopped: ${reason}` });
    const reported = [...L.keys()].some((k) => k === 'run-report' || /^pr\d+-report$/.test(k));
    if (!open.length && !reported) out.ops.push({ op: 'report', pr: null, outcome: `stopped: ${reason}` });
    return out;
  }

  if (s.action === 'drill') {
    if (!s.fireConfigured) out.log.push('drill skipped: the task trigger is not configured');
    else if (has('drill')) out.log.push('drill already ran for this run id');
    else out.fires.push({ key: 'drill', a: 1, payload: 'VANTA-DRILL' });
    return out;
  }
  if (!s.armed) {
    out.log.push('not armed: no agent will be started');
    return out;
  }
  if (!s.fireConfigured) {
    out.log.push('armed, but the task trigger is not configured: nothing started');
    return out;
  }

  const block = (key, pr, why) => {
    if (has(`${key}-blocked`) || (pr && has(`pr${pr}-report`))) return;
    out.ops.push({ op: 'ledger', key: `${key}-blocked`, state: 'success', d: { n: why.slice(0, 90) } });
    if (pr) out.ops.push({ op: 'label', pr, label: 'vanta:blocked' });
    out.ops.push({ op: 'report', pr, dev: !pr || pr === devPr?.number, outcome: `blocked: ${why}` });
  };
  const act = (dec, key, payload, h, pr) => {
    if (dec.do === 'fire') out.fires.push({ key, a: dec.a, payload, h });
    else if (dec.do === 'block') block(key, pr, dec.why);
    out.log.push(`${key}: ${dec.do}${dec.why ? ` (${dec.why})` : ''}`);
  };

  // Develop: one pull request from a claude/ branch, opened after the first start.
  const dev = L.get('develop') ?? [];
  const devPr = dev.length ? s.prs.find((p) => p.isDevelop && p.createdAt >= dev[0].t) : null;
  if (!has('develop-blocked')) act(fireDecision(dev, Boolean(devPr), s.now), 'develop', 'VANTA-DEVELOP', undefined, null);

  for (const p of open) {
    if (!(p.isSeed || (devPr && p.number === devPr.number))) continue;
    if (has(`pr${p.number}-report`)) continue;
    const h = p.headSha.slice(0, 7);
    const rounds = [...L.keys()].filter((k) => new RegExp(`^pr${p.number}-r\\d+$`).test(k));
    const inFlight = rounds.find((k) => L.get(k)[0]?.h === h);
    if (inFlight) {
      // A repair was started for this exact head; the head has not moved yet.
      if (!has(`${inFlight}-blocked`)) act(fireDecision(L.get(inFlight), false, s.now), inFlight, repairPayload(p, Number(inFlight.split('-r')[1])), h, p.number);
      continue;
    }
    if (p.ci === 'pending' || p.guard === 'pending') {
      out.log.push(`pr${p.number}: waiting for CI on ${h}`);
      continue;
    }
    if (p.guard === 'fail') {
      block(`pr${p.number}`, p.number, 'vanta-guard failed');
      continue;
    }
    if (!p.review) {
      const rq = `pr${p.number}-reviewreq-${h}`;
      if (!has(rq)) {
        if (s.now - p.ciDoneAt >= LIMITS.reviewWaitMs) {
          out.ops.push({ op: 'comment', pr: p.number, body: '@codex review' });
          out.ops.push({ op: 'ledger', key: rq, state: 'success', d: {} });
          out.log.push(`pr${p.number}: no Codex review on ${h}, requested one`);
        } else out.log.push(`pr${p.number}: waiting for the Codex review of ${h}`);
      } else if (s.now - L.get(rq)[0].t >= LIMITS.reviewWaitMs) block(`pr${p.number}`, p.number, `no Codex review of ${h}, even after a request`);
      else out.log.push(`pr${p.number}: waiting for the requested Codex review of ${h}`);
      continue;
    }
    if (p.ci === 'pass' && p.review.findings === 0) {
      out.ops.push({ op: 'label', pr: p.number, label: 'vanta:verified' });
      out.ops.push({ op: 'report', pr: p.number, dev: p.isDevelop, outcome: `verified at ${h} (${rounds.length} repair round(s); Codex ${p.review.via} ${p.review.id})` });
      continue;
    }
    const k = rounds.length + 1;
    if (k > LIMITS.maxRepairRounds) {
      block(`pr${p.number}`, p.number, `repair limit reached (${LIMITS.maxRepairRounds} rounds) and ${h} still needs repair`);
      out.ops.push({ op: 'close', pr: p.number });
      continue;
    }
    act({ do: 'fire', a: 1 }, `pr${p.number}-r${k}`, repairPayload(p, k), h, p.number);
  }
  return out;
}

const repairPayload = (p, round) => `VANTA-REPAIR pr=${p.number} branch=${p.headRef} round=${round} head=${p.headSha}`;

// ---------------------------------------------------------------- I/O (GitHub Actions only)

async function snapshot(gh, cfg, runId, now) {
  const R = gh.repo;
  const ledger = parseLedger(await gh.all(`/repos/${R}/commits/${cfg.ledgerSha}/statuses`), runId);
  const trusted = new Set([...(await gh.all(`/repos/${R}/commits?sha=main`)).map((c) => c.sha), ...(cfg.trustedCommits ?? [])]);
  const tripwire = [];
  for (const b of await gh.all(`/repos/${R}/branches`)) {
    if (b.name === 'main') continue;
    const shas = (await gh.all(`/repos/${R}/commits?sha=${encodeURIComponent(b.name)}`)).map((c) => c.sha);
    tripwire.push(...(await protectedChanges(gh, shas, trusted)));
  }
  const prs = [];
  for (const p of await gh.all(`/repos/${R}/pulls?state=open`)) {
    if (p.user?.login !== cfg.owner || p.base?.ref !== 'main' || p.head?.repo?.full_name !== R) continue;
    const head = p.head.sha;
    const runs = (await gh.all(`/repos/${R}/commits/${head}/check-runs`)).filter((c) => c.app?.slug === 'github-actions');
    const agg = (name) => {
      const xs = runs.filter((c) => c.name === name);
      if (!xs.length || xs.some((c) => c.status !== 'completed')) return { v: 'pending' };
      return {
        v: xs.every((c) => c.conclusion === 'success') ? 'pass' : 'fail',
        done: Math.max(...xs.map((c) => Date.parse(c.completed_at))),
        started: Math.min(...xs.map((c) => Date.parse(c.started_at))),
      };
    };
    const ci = agg('test');
    const guard = agg('vanta-guard');
    let review = null;
    if (ci.v !== 'pending') {
      const reviews = (await gh.all(`/repos/${R}/pulls/${p.number}/reviews`)).filter((r) => r.user?.login === CODEX_BOT && r.commit_id === head);
      const last = reviews.at(-1);
      if (last) {
        const comments = await gh.all(`/repos/${R}/pulls/${p.number}/reviews/${last.id}/comments`);
        review = { id: last.id, via: 'review', findings: countFindings([last.body, ...comments.map((c) => c.body)]) };
      } else {
        // Codex may answer a clean commit with a comment instead of a review. Only an explicit
        // "no issues" comment after this head's CI started counts; anything else keeps waiting.
        const c = (await gh.all(`/repos/${R}/issues/${p.number}/comments`))
          .filter((x) => x.user?.login === CODEX_BOT && Date.parse(x.created_at) >= ci.started)
          .at(-1);
        if (c && /\b(no|didn't find any|did not find any) (major )?issues\b/i.test(c.body ?? '') && countFindings([c.body]) === 0) review = { id: c.id, via: 'comment', findings: 0 };
      }
    }
    prs.push({
      number: p.number,
      state: p.state,
      headRef: p.head.ref,
      headSha: head,
      createdAt: Date.parse(p.created_at),
      labels: (p.labels ?? []).map((l) => l.name),
      isDevelop: p.head.ref.startsWith('claude/'),
      isSeed: p.head.ref === cfg.seedBranch,
      ci: ci.v,
      guard: guard.v,
      ciDoneAt: Math.max(ci.done ?? 0, guard.done ?? 0) || now,
      review,
    });
  }
  return { ledger, tripwire, prs };
}

async function fireTask(url, token, text) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {}
    return classifyFire(res.status, body, res.headers.get('retry-after'));
  } catch (e) {
    return { outcome: 'unknown', code: 0, note: e?.name === 'AbortError' ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps the status description within GitHub's 140 characters without breaking the JSON. */
export function ledgerDescription(d) {
  const o = Object.fromEntries(Object.entries(d).filter(([, v]) => v != null));
  let s = JSON.stringify(o);
  while (s.length > 140 && typeof o.n === 'string' && o.n.length > 0) {
    o.n = o.n.slice(0, Math.max(0, o.n.length - (s.length - 140) - 1));
    s = JSON.stringify(o);
  }
  return s.length > 140 ? JSON.stringify({ a: o.a, n: 'truncated' }) : s;
}

function reportBody(outcome, pr, dev, ledger, runId, owner) {
  const rows = [...ledger]
    .filter(([k]) => (dev && k === 'develop') || (pr && new RegExp(`^pr${pr}-r\\d+$`).test(k)))
    .flatMap(([k, at]) => at.map((x) => `| ${k} | ${x.a} | ${x.state}${x.code != null ? ` (${x.code})` : ''} | ${new Date(x.t).toISOString()} | ${x.url ?? ''} |`));
  return [
    `**VANTA trial \`${runId}\`: ${outcome}**`,
    '',
    rows.length ? '| step | attempt | result | at | session |\n|---|---|---|---|---|\n' + rows.join('\n') : 'No agent sessions were started.',
    '',
    `@${owner} this is the coordinator's report. Nothing was merged.`,
  ].join('\n');
}

async function main() {
  const now = Date.now();
  const say = (line) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const cfg = loadConfig();
  if (!cfg?.ledgerSha || !cfg.owner) {
    say('No .github/vanta/config.json: nothing to do.');
    return;
  }
  const gh = github(process.env.GITHUB_TOKEN, process.env.GITHUB_REPOSITORY);
  const R = gh.repo;
  const runId = /^[\w-]{1,20}$/.test(process.env.VANTA_RUN_ID ?? '') ? process.env.VANTA_RUN_ID : 'drill';
  const fireUrl = process.env.FIRE_URL ?? '';
  const fireToken = process.env.FIRE_TOKEN ?? '';
  const fireConfigured = FIRE_URL_RE.test(fireUrl) && fireToken.length > 0;
  if (fireUrl && !FIRE_URL_RE.test(fireUrl)) say('CLAUDE_TASK_FIRE_URL is not a task trigger URL on api.anthropic.com: starts disabled.');
  const action = ['tick', 'drill', 'stop'].includes(process.env.VANTA_ACTION) ? process.env.VANTA_ACTION : 'tick';
  const snap = await snapshot(gh, cfg, runId, now);
  const plan = decide({ ...snap, now, action, armed: process.env.VANTA_ARMED === 'true', runId, fireConfigured });

  const ledgerWrite = (key, state, d = {}, target_url) =>
    gh.post(`/repos/${R}/statuses/${cfg.ledgerSha}`, {
      state,
      context: `vanta-ledger/${runId}/${key}`,
      description: ledgerDescription(d),
      ...(target_url ? { target_url } : {}),
    });

  say(`run \`${runId}\` · action ${action} · armed ${process.env.VANTA_ARMED === 'true'} · trigger configured ${fireConfigured}`);
  for (const line of plan.log) say(`- ${line}`);

  for (const op of plan.ops) {
    if (op.op === 'ledger') await ledgerWrite(op.key, op.state, op.d);
    else if (op.op === 'close') await gh.patch(`/repos/${R}/pulls/${op.pr}`, { state: 'closed' });
    else if (op.op === 'label') await gh.post(`/repos/${R}/issues/${op.pr}/labels`, { labels: [op.label] });
    else if (op.op === 'comment') await gh.post(`/repos/${R}/issues/${op.pr}/comments`, { body: op.body });
    else if (op.op === 'report') {
      const body = reportBody(op.outcome, op.pr, op.dev, snap.ledger, runId, cfg.owner);
      if (op.pr) {
        await gh.post(`/repos/${R}/issues/${op.pr}/comments`, { body });
        await ledgerWrite(`pr${op.pr}-report`, 'success', { n: op.outcome.slice(0, 90) });
      } else {
        await gh.post(`/repos/${R}/issues`, { title: `VANTA trial ${runId}: ${op.outcome}`.slice(0, 120), body });
        await ledgerWrite('run-report', 'success', { n: op.outcome.slice(0, 90) });
      }
    }
  }

  for (const f of plan.fires) {
    // Write-ahead: if this write fails, the start is not attempted.
    await ledgerWrite(f.key, 'pending', { a: f.a, h: f.h });
    const r = await fireTask(fireUrl, fireToken, f.payload);
    const state = r.outcome === 'launched' ? 'success' : r.outcome === 'not_started' ? 'failure' : 'error';
    await ledgerWrite(f.key, state, { a: f.a, h: f.h, c: r.code, r: r.retryAfter, n: r.note }, r.url);
    say(`- start ${f.key} attempt ${f.a}: ${r.outcome} (HTTP ${r.code})${r.outcome === 'launched' && f.key === 'drill' ? ' WARNING: the drill started a session, so the task was NOT paused' : ''}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
}
