// vanta-guard: fails when any commit in the pull request (other than the owner's trusted setup
// commits) touches a protected path. Runs from main via pull_request_target; reads only API data.
import { github, loadConfig, protectedChanges } from './lib.mjs';

const pr = Number(process.env.PR_NUMBER);
if (!Number.isInteger(pr) || pr <= 0) {
  console.error('vanta-guard: missing pull request number');
  process.exit(1);
}
const gh = github(process.env.GITHUB_TOKEN, process.env.GITHUB_REPOSITORY);
const trusted = new Set(loadConfig()?.trustedCommits ?? []);
const commits = await gh.all(`/repos/${gh.repo}/pulls/${pr}/commits`);
const hits = await protectedChanges(gh, commits.map((c) => c.sha), trusted);
if (hits.length) {
  console.error('vanta-guard FAILED: this pull request changes protected paths:');
  for (const h of hits) console.error(`  ${h.sha.slice(0, 7)}  ${h.path}`);
  process.exit(1);
}
console.log(`vanta-guard passed: ${commits.length} commit(s), no protected path changed.`);
