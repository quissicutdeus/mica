import fs from 'node:fs';

/**
 * Reject a push that would create or update a branch not named for a Jira
 * ticket key (AGENTS.md §12).
 *
 * A pre-push hook, not pre-commit, because the branch name only matters at the
 * moment it reaches the remote: renaming a local scratch branch before pushing
 * is fine, and blocking every commit on a WIP name would just teach people to
 * pass --no-verify habitually.
 *
 * It reads git's pre-push stdin (`<local ref> <local sha> <remote ref> <remote
 * sha>` per line) and judges the REMOTE ref, which is the name actually being
 * created -- `git push origin HEAD:refs/heads/MICA-56` is legal even from a
 * differently-named local branch, and judging the local branch would wrongly
 * reject it.
 *
 * Deletions are always allowed, whatever the name: a rule that forbade them
 * would make every pre-existing non-conforming branch permanently unremovable,
 * which is the opposite of the point. Tags are not this rule's business either.
 *
 * This is the client half. Its blind spot is anything that does not push
 * through a local hook -- the GitHub web UI, and Dependabot, which opens its
 * own dependabot/* branches server-side. The ruleset in
 * .github/rulesets/ticket-key-branch-names.json covers that side and excludes
 * dependabot/** deliberately; see the note in AGENTS.md §12.
 *
 * Deliberate bypass: git push --no-verify
 */

const PATTERN = /^(main|dev|MICA-[0-9]+(-[a-z0-9]+)*)$/;
const ZERO = /^0+$/;

let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {
  process.exit(0); // No stdin (invoked by hand, not by git) -- nothing to judge.
}

const offenders = [];
for (const line of input.split('\n')) {
  const [, localSha, remoteRef] = line.trim().split(/\s+/);
  if (!remoteRef || !remoteRef.startsWith('refs/heads/')) continue; // tag, or blank
  if (ZERO.test(localSha ?? '')) continue; // deletion

  const name = remoteRef.slice('refs/heads/'.length);
  if (!PATTERN.test(name)) offenders.push(name);
}

if (offenders.length > 0) {
  console.error('pre-push: branch names must be a MICA ticket key (AGENTS.md 12).\n');
  for (const name of offenders) console.error(`  refused: ${name}`);
  console.error('\n  Allowed: main, dev, MICA-<n>, MICA-<n>-short-slug');
  console.error('  Rename:  git branch -m MICA-56-short-slug');
  console.error('  Bypass:  git push --no-verify');
  process.exit(1);
}
