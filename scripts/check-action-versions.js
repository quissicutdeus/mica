// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Verify that workflow actions are pinned to commit SHAs and check for newer majors.
 *
 * Every `uses:` must be a full 40-hex commit SHA (with a version comment for reference).
 * This enforces supply-chain security: a moving tag like `@v7` can be force-pushed to point
 * at a different commit, which is a privilege escalation if that commit is malicious. SHA
 * pins are immutable.
 *
 * For any tag ref found (recovered from the comment), the script also reports whether a
 * newer major exists, so upgrades are deliberate and planned.
 *
 *   node scripts/check-action-versions.js            fail if SHAs are not pinned or a newer major exists
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

/** A full commit SHA: 40 hex characters */
const SHA = /^[0-9a-f]{40}$/;

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

for (const [repo, { refs, files }] of [...pins].sort()) {
  const where = [...files].sort().join(', ');
  for (const { ref, comment } of [...refs].sort((a, b) => a.ref.localeCompare(b.ref))) {
    // Every action must be pinned to a full commit SHA
    if (!SHA.exec(ref)) {
      notSha.push({ repo, ref, where, comment });
      continue;
    }

    // Extract the version tag from the comment (e.g., "v7" from "v7")
    if (!comment) {
      // No version comment, can't check for newer majors but the SHA is still pinned
      current.push({ repo, ref, latest: '(no comment)' });
      continue;
    }

    const version = comment.trim();
    const pinned = VTAG.exec(version);
    if (!pinned) {
      current.push({ repo, ref, latest: version });
      continue;
    }

    try {
      const latest = await latestMajor(repo);
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
  `\n${current.length} pinned, ${behind.length} behind, ${unresolved.length} unresolved, ${notSha.length} not SHA-pinned`
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
