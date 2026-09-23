// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every workflow action is pinned to a commit SHA, and none has fallen a major behind.
 *
 * Two checks, in that order. A `uses:` must be a full 40-hex commit SHA with the version
 * it was resolved from in a trailing comment (`@3d3c42e... # v7`). A `@v7` tag is a
 * moving target -- GitHub re-points it at every v7.x release, and whoever can push to the
 * action's repository can re-point it at anything -- so a tag is trust in a maintainer's
 * account for as long as the workflow runs, where a SHA is trust in one reviewed commit
 * (MICA-199). Then, from the comment, the script asks whether a newer MAJOR exists.
 * Only the major, deliberately: drift inside a major is what the SHA pin exists to hold
 * still, and drift across one is where a runtime deprecation lands.
 *
 * A pin may be **held** at an older major on purpose, and the hold has to be written
 * where the pin is: `@<sha> # v3 held: <reason>`. The tag is still recorded and the SHA is
 * still required; what changes is that no newer major is asked for. The first hold was
 * `actions/upload-artifact`, whose v4+ refuses to run on any host but github.com while
 * the same workflow also runs on Forgejo. A hold with no reason is not a hold -- the
 * marker without text is reported as unresolved, so "held:" cannot become a way to
 * silence the check without saying why.
 * `.github/dependabot.yml` used to watch the majors and was deleted -- every merge of one
 * of its pull requests put dependabot[bot] in the repository's contributor list, which is
 * not a trade worth making for a weekly bump. Renovate was considered for the SHA pins and
 * not adopted for the same reason. This script opens no pull request and authors no
 * commit; a bump is a human reading the release notes and resolving the tag by hand
 * (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, dereferencing an annotated tag once).
 *
 * It FAILS on anything it could not judge rather than passing quietly: a pin with no
 * version comment, a comment that is not a `vN` tag, a rate limit, a network error. A
 * version check that cannot reach the API and says nothing reads as "everything is
 * current", which is the worst answer it could give -- so those are an exit code, not a
 * warning. What it cannot see is whether the SHA is a real commit of that repository;
 * `actions/checkout` refuses to resolve one that is not, so a fabricated pin fails the
 * first workflow run that reaches it, loudly.
 *
 *   node scripts/check-action-versions.js            fail on an unpinned ref or a newer major
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
const USES =
  /^\s*-?\s*uses:\s*['"]?([\w.-]+)\/([\w.-]+)((?:\/[^@\s'"]+)?)@([^\s'"#]+)(?:\s*#\s*(.*))?/;

/** A tag this can reason about: `v7`, `v7.1`, `v7.1.2`. Anything else is unresolvable. */
const VTAG = /^v(\d+)(?:\.\d+)*$/;

/** `v3 held: <reason>` -- a deliberate stop at an older major, with the reason beside it. */
const HELD = /^(v\d+(?:\.\d+)*)\s+held:\s*(.*)$/;

/** A full commit SHA: 40 hex characters */
const SHA = /^[0-9a-f]{40}$/;

/**
 * A job's `GITHUB_TOKEN` is issued by whichever server runs the job. On Forgejo that is a
 * Forgejo token, and api.github.com answers it with 401 -- every lookup came back
 * UNKNOWN on the weekly run until this checked where the token came from. A token that
 * github.com did not issue is not sent; the run falls back to `gh`, then to anonymous,
 * which fits the one lookup per action below inside the 60-an-hour limit.
 */
function token() {
  const server = process.env.GITHUB_SERVER_URL;
  const env = { ...process.env };
  if (env.GITHUB_TOKEN) {
    if (!server || server === 'https://github.com') return env.GITHUB_TOKEN;
    console.log(`ignoring GITHUB_TOKEN: it was issued by ${server}, not github.com`);
    // `gh` treats GITHUB_TOKEN in its environment as its own login, so asking it would
    // hand the same foreign token straight back. The runner image ships `gh`.
    delete env.GITHUB_TOKEN;
  }
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', env });
  return gh.status === 0 ? gh.stdout.trim() : '';
}

const AUTH = token();

async function api(url) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'mica-action-drift' };
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

/**
 * One lookup per repository, however many times it is pinned. `refs` holds an entry per
 * `uses:` line, so `actions/checkout` alone was asked for nine times -- thirty requests
 * where thirteen answer the question, which an anonymous run cannot afford.
 */
const latestByRepo = new Map();
const latestMajorOnce = (repo) => {
  if (!latestByRepo.has(repo)) latestByRepo.set(repo, latestMajor(repo));
  return latestByRepo.get(repo);
};

/** Every `owner/repo` used across the workflows, with the SHAs and tags it is pinned at. */
function collect() {
  const pins = new Map();
  for (const file of fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8').split('\n');
    for (const line of lines) {
      const match = USES.exec(line);
      if (!match) continue;
      const [, owner, name, , ref, comment] = match;
      const repo = `${owner}/${name}`;
      if (!pins.has(repo)) pins.set(repo, { refs: new Set(), files: new Set() });
      pins.get(repo).refs.add({ ref, comment });
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

const notSha = [];
const behind = [];
const unresolved = [];
const current = [];
const held = [];

for (const [repo, { refs, files }] of [...pins].sort()) {
  const where = [...files].sort().join(', ');
  for (const { ref, comment } of [...refs].sort((a, b) => a.ref.localeCompare(b.ref))) {
    // Every action must be pinned to a full commit SHA
    if (!SHA.exec(ref)) {
      notSha.push({ repo, ref, where, comment });
      continue;
    }

    // The comment is the only record of which tag the SHA came from. Without it the
    // major check has nothing to compare, and "could not check" is a failure here, not a
    // pass -- see the docblock.
    const version = (comment ?? '').trim();

    // A hold: the tag is recorded, the major is not compared. The reason is mandatory.
    const hold = HELD.exec(version);
    if (hold) {
      if (!hold[2].trim()) {
        unresolved.push({ repo, ref, version, where, why: "'held:' with no reason is not a hold" });
      } else {
        held.push({ repo, ref, version: hold[1], reason: hold[2].trim() });
      }
      continue;
    }

    const pinned = VTAG.exec(version);
    if (!pinned) {
      unresolved.push({
        repo,
        ref,
        version,
        where,
        why: version ? `comment '${version}' is not a vN tag` : 'no version comment after the SHA'
      });
      continue;
    }

    try {
      const latest = await latestMajorOnce(repo);
      if (latest.major > Number(pinned[1])) {
        behind.push({ repo, ref, version, latest: latest.tag, where });
      } else {
        current.push({ repo, ref, latest: latest.tag });
      }
    } catch (error) {
      unresolved.push({ repo, ref, version, where, why: error.message });
    }
  }
}

for (const { repo, ref, latest } of current) {
  console.log(`  ok        ${repo}@${ref.slice(0, 8)}...  (${latest})`);
}
for (const { repo, ref, version, reason } of held) {
  console.log(`  held      ${repo}@${ref.slice(0, 8)}...  at ${version}: ${reason}`);
}
for (const { repo, ref, latest, where } of behind) {
  console.log(`  BEHIND    ${repo}@${ref.slice(0, 8)}... -> ${latest}   in ${where}`);
}
for (const { repo, ref, where, why } of unresolved) {
  console.log(`  UNKNOWN   ${repo}@${ref.slice(0, 8)}...   in ${where}: ${why}`);
}
for (const { repo, ref, where, comment } of notSha) {
  console.log(`  NOT SHA   ${repo}@${ref}   in ${where}${comment ? ` (comment: ${comment})` : ''}`);
}

console.log(
  `\n${current.length} pinned, ${held.length} held, ${behind.length} behind, ${unresolved.length} unresolved, ${notSha.length} not SHA-pinned`
);

if (LIST_ONLY) process.exit(0);

if (notSha.length > 0) {
  console.error('\nAll actions must be pinned to a full commit SHA (40 hex characters).');
  console.error('Add the version as a comment, e.g., `@abc1234567...def # v7`.');
}
if (behind.length > 0) {
  console.error('\nA newer major exists for the actions marked BEHIND. Bump the SHA and comment');
  console.error("after reading that major's release notes -- majors carry breaking changes.");
}
if (unresolved.length > 0) {
  console.error('\nSome actions could not be checked, which is reported as a failure rather');
  console.error('than a pass: a silent version check reads as "everything is current".');
}
process.exit(notSha.length + behind.length + unresolved.length > 0 ? 1 : 0);
