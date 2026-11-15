// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every workflow action follows its major tag, and none has fallen a major behind.
 *
 * Two checks, in that order. A `uses:` must name a bare major tag (`@v7`): GitHub moves
 * that tag to every v7.x release, so each run takes the newest one without anyone
 * bumping it. A commit SHA or an exact version (`@v7.1.0`) holds the action still, which
 * is what this repository decided against on 2026-11-15: until then every action was
 * SHA-pinned (MICA-199), trusting one reviewed commit rather than the maintainer's
 * account, and the pins fell a release or two behind between the bumps nobody made. The
 * trade taken is that whoever can push to an action's repository can re-point its major
 * tag; the actions used here are GitHub's own, Docker's and pnpm's. Then the script asks
 * whether a newer MAJOR exists, since a major is where breaking changes and runtime
 * deprecations land, and moving to one wants its release notes read.
 *
 * A tag may be **held** at an older major on purpose, and the hold has to be written
 * where the tag is: `@v3 # held: <reason>`. What changes is that no newer major is asked
 * for. The first hold was `actions/upload-artifact`, whose v4+ refused to run on any host
 * but github.com while the same workflow also ran on Forgejo. A hold with no reason is
 * not a hold -- the marker without text is reported as unresolved, so "held:" cannot
 * become a way to silence the check without saying why.
 *
 * `.github/dependabot.yml` used to watch the majors and was deleted -- every merge of one
 * of its pull requests put dependabot[bot] in the repository's contributor list, which is
 * not a trade worth making for a weekly bump. This script opens no pull request and
 * authors no commit; a major bump is a human reading the release notes and editing the
 * tag.
 *
 * It FAILS on anything it could not judge rather than passing quietly: a hold with no
 * reason, a ref it cannot read as a major, a rate limit, a network error. A version
 * check that cannot reach the API and says nothing reads as "everything is current",
 * which is the worst answer it could give -- so those are an exit code, not a warning.
 * What it cannot see is whether the action publishes that major at all; GitHub refuses
 * a `uses:` it cannot resolve at "Set up job", so a mistyped tag fails the first
 * workflow run that reaches it, loudly.
 *
 *   node scripts/check-action-versions.js            fail on a ref that is not a major tag, or a newer major
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

/** `@v3 # held: <reason>` -- a deliberate stop at an older major, with the reason beside it. */
const HELD = /^held:\s*(.*)$/;

/** A bare major tag, the only ref that follows the action's releases: `v7`. */
const MAJOR = /^v(\d+)$/;

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

/** Every `owner/repo` used across the workflows, with the refs it is used at. */
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

const notMajor = [];
const behind = [];
const unresolved = [];
const current = [];
const held = [];

for (const [repo, { refs, files }] of [...pins].sort()) {
  const where = [...files].sort().join(', ');
  for (const { ref, comment } of [...refs].sort((a, b) => a.ref.localeCompare(b.ref))) {
    // Every action must follow a bare major tag: a SHA or an exact version holds it still.
    const tag = MAJOR.exec(ref);
    if (!tag) {
      notMajor.push({ repo, ref, where });
      continue;
    }

    // A hold: the major is not compared to the latest. The reason is mandatory.
    const hold = HELD.exec((comment ?? '').trim());
    if (hold) {
      if (!hold[1].trim()) {
        unresolved.push({ repo, ref, where, why: "'held:' with no reason is not a hold" });
      } else {
        held.push({ repo, ref, reason: hold[1].trim() });
      }
      continue;
    }

    try {
      const latest = await latestMajorOnce(repo);
      if (latest.major > Number(tag[1])) {
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
for (const { repo, ref, reason } of held) {
  console.log(`  held      ${repo}@${ref}: ${reason}`);
}
for (const { repo, ref, latest, where } of behind) {
  console.log(`  BEHIND    ${repo}@${ref} -> ${latest}   in ${where}`);
}
for (const { repo, ref, where, why } of unresolved) {
  console.log(`  UNKNOWN   ${repo}@${ref}   in ${where}: ${why}`);
}
for (const { repo, ref, where } of notMajor) {
  console.log(`  NOT MAJOR ${repo}@${ref}   in ${where}`);
}

console.log(
  `\n${current.length} current, ${held.length} held, ${behind.length} behind, ${unresolved.length} unresolved, ${notMajor.length} not on a major tag`
);

if (LIST_ONLY) process.exit(0);

if (notMajor.length > 0) {
  console.error('\nEvery action must follow a bare major tag, e.g. `@v7`: a commit SHA or an');
  console.error('exact version holds it at one release while the major moves on.');
}
if (behind.length > 0) {
  console.error('\nA newer major exists for the actions marked BEHIND. Move the tag');
  console.error("after reading that major's release notes -- majors carry breaking changes.");
}
if (unresolved.length > 0) {
  console.error('\nSome actions could not be checked, which is reported as a failure rather');
  console.error('than a pass: a silent version check reads as "everything is current".');
}
process.exit(notMajor.length + behind.length + unresolved.length > 0 ? 1 : 0);
