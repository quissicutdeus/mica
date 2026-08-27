/**
 * Report workflow actions that have been left behind on an older major.
 *
 * `.github/dependabot.yml` used to watch this and was deleted -- every merge of one of
 * its pull requests put dependabot[bot] in the repository's contributor list, which is
 * not a trade worth making for a weekly bump. But the github-actions half of that config
 * existed for a reason: `upload-artifact@v4` and `pnpm/action-setup@v4` both sat on a
 * deprecated Node runtime for months with nothing saying so, because a `@vN` tag keeps
 * working long after it stops being maintained. This is the replacement, and it opens no
 * pull request and authors no commit.
 *
 * Only the MAJOR is compared, deliberately. `uses: actions/checkout@v7` is a moving tag:
 * GitHub re-points it at every v7.x release, so a repo pinned that way is already current
 * within its major and a minor-level report would be pure noise. Drift that matters is
 * drift across the major boundary, which is exactly where a runtime deprecation lands.
 *
 * It FAILS on anything it could not resolve rather than passing quietly. A version check
 * that cannot reach the API and says nothing reads as "everything is current", which is
 * the worst answer it could give -- so a rate limit, a network error, or a tag this does
 * not understand is an exit code, not a warning.
 *
 *   node scripts/check-action-versions.js            fail if anything is behind
 *   node scripts/check-action-versions.js --list      print findings, always exit 0
 *   node scripts/check-action-versions.js --dir=DIR   scan DIR instead, to prove it fires
 *
 * GITHUB_TOKEN lifts the API's 60-requests-per-hour anonymous limit to 5000. CI supplies
 * one; locally this falls back to `gh auth token`, and runs unauthenticated if neither is
 * there -- a dozen requests fits inside 60, it is just fragile if you run it in a loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LIST_ONLY = process.argv.includes('--list');

// `--dir` exists so the failing path can be demonstrated on demand. A gate nobody has
// watched fail is a gate nobody knows the shape of, and pinning a workflow backwards just
// to test this one would mean pushing a deliberately stale `uses:` to find out.
const DIR_ARG = process.argv.find((a) => a.startsWith('--dir='));
const WORKFLOWS = DIR_ARG ? DIR_ARG.slice('--dir='.length) : '.github/workflows';

/** `uses: owner/repo/optional/subpath@ref`, ignoring `uses: ./local` and `docker://`. */
const USES = /^\s*-?\s*uses:\s*['"]?([\w.-]+)\/([\w.-]+)((?:\/[^@\s'"]+)?)@([^\s'"#]+)/;

/** A tag this can reason about: `v7`, `v7.1`, `v7.1.2`. Anything else is unresolvable. */
const VTAG = /^v(\d+)(?:\.\d+)*$/;

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  return gh.status === 0 ? gh.stdout.trim() : '';
}

const AUTH = token();

async function api(url) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'gphone-action-drift' };
  if (AUTH) headers.authorization = `Bearer ${AUTH}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const limit = remaining === '0' ? ' (rate limit exhausted -- set GITHUB_TOKEN)' : '';
    throw new Error(`${response.status} ${response.statusText} for ${url}${limit}`);
  }
  return response.json();
}

/**
 * The newest major this action has published.
 *
 * `releases/latest` first, because it is what the maintainer marked as current. Actions
 * that tag without releasing (or that only draft) 404 there, so fall back to the tag list
 * and take the highest major it contains.
 */
async function latestMajor(repo) {
  try {
    const release = await api(`https://api.github.com/repos/${repo}/releases/latest`);
    const match = VTAG.exec(release.tag_name ?? '');
    if (match) return { major: Number(match[1]), tag: release.tag_name, from: 'release' };
  } catch (error) {
    if (!error.message.startsWith('404 ')) throw error;
  }

  const tags = await api(`https://api.github.com/repos/${repo}/tags?per_page=100`);
  let best = null;
  for (const { name } of tags) {
    const match = VTAG.exec(name ?? '');
    if (match && (best === null || Number(match[1]) > best.major)) {
      best = { major: Number(match[1]), tag: name, from: 'tag' };
    }
  }
  if (best === null) throw new Error(`no vN release or tag found for ${repo}`);
  return best;
}

/** Every `owner/repo` used across the workflows, with the majors it is pinned at. */
function collect() {
  const pins = new Map();
  for (const file of fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8').split('\n');
    for (const line of lines) {
      const match = USES.exec(line);
      if (!match) continue;
      const [, owner, name, , ref] = match;
      const repo = `${owner}/${name}`;
      if (!pins.has(repo)) pins.set(repo, { refs: new Set(), files: new Set() });
      pins.get(repo).refs.add(ref);
      pins.get(repo).files.add(file);
    }
  }
  return pins;
}

const pins = collect();
if (pins.size === 0) {
  console.error(`No \`uses:\` entries found under ${WORKFLOWS}/ -- is the path still right?`);
  process.exit(1);
}

const behind = [];
const unresolved = [];
const current = [];

for (const [repo, { refs, files }] of [...pins].sort()) {
  const where = [...files].sort().join(', ');
  for (const ref of [...refs].sort()) {
    const pinned = VTAG.exec(ref);
    if (!pinned) {
      unresolved.push({ repo, ref, where, why: 'not a vN tag (a SHA pin or a branch)' });
      continue;
    }
    try {
      const latest = await latestMajor(repo);
      if (latest.major > Number(pinned[1])) {
        behind.push({ repo, ref, latest: latest.tag, where });
      } else {
        current.push({ repo, ref, latest: latest.tag });
      }
    } catch (error) {
      unresolved.push({ repo, ref, where, why: error.message });
    }
  }
}

for (const { repo, ref, latest } of current) {
  console.log(`  ok        ${repo}@${ref}  (latest ${latest})`);
}
for (const { repo, ref, latest, where } of behind) {
  console.log(`  BEHIND    ${repo}@${ref} -> ${latest}   in ${where}`);
}
for (const { repo, ref, where, why } of unresolved) {
  console.log(`  UNKNOWN   ${repo}@${ref}   in ${where}: ${why}`);
}

console.log(
  `\n${current.length} current, ${behind.length} behind, ${unresolved.length} unresolved`
);

if (LIST_ONLY) process.exit(0);

if (behind.length > 0) {
  console.error('\nA newer major exists for the actions marked BEHIND. Bump the `uses:` tag');
  console.error("after reading that major's release notes -- majors carry breaking changes.");
}
if (unresolved.length > 0) {
  console.error('\nSome actions could not be checked, which is reported as a failure rather');
  console.error('than a pass: a silent version check reads as "everything is current".');
}
process.exit(behind.length + unresolved.length > 0 ? 1 : 0);
