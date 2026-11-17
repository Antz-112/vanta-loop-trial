// Shared by vanta-guard and the coordinator. Both run from main only.
import { readFileSync } from 'node:fs';

export const API = 'https://api.github.com';
export const CODEX_BOT = 'chatgpt-codex-connector[bot]';
export const ACTIONS_BOT = 'github-actions[bot]';

/** Paths no agent may change. A commit touching one fails vanta-guard and stops the trial. */
export const PROTECTED = [/^\.github\//, /^\.claude\//, /^test\/acceptance\//, /^AGENTS\.md$/, /^CLAUDE\.md$/, /^SPEC\.md$/, /^package\.json$/];
export const isProtected = (path) => PROTECTED.some((re) => re.test(path));

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

/** Minimal GitHub REST client using the workflow's own token. */
export function github(token, repo) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  async function req(url, { method = 'GET', body } = {}) {
    const res = await fetch(url.startsWith('https://') ? url : `${API}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${url} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { res, data: res.status === 204 ? null : await res.json() };
  }
  async function all(path) {
    let url = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    const items = [];
    for (let page = 0; url && page < 30; page++) {
      const { res, data } = await req(url);
      items.push(...(Array.isArray(data) ? data : (data.check_runs ?? [])));
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    }
    return items;
  }
  return {
    repo,
    get: async (p) => (await req(p)).data,
    all,
    post: async (p, body) => (await req(p, { method: 'POST', body })).data,
    patch: async (p, body) => (await req(p, { method: 'PATCH', body })).data,
  };
}

/** Protected paths changed by any of `shas` (each commit checked on its own, so a later revert hides nothing). */
export async function protectedChanges(gh, shas, trusted) {
  const hits = [];
  for (const sha of shas) {
    if (trusted.has(sha)) continue;
    const commit = await gh.get(`/repos/${gh.repo}/commits/${sha}`);
    for (const f of commit.files ?? []) {
      for (const p of [f.filename, f.previous_filename]) if (p && isProtected(p)) hits.push({ sha, path: p });
    }
  }
  return hits;
}
