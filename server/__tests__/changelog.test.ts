import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every versioned migration is announced to server owners, enforced.
 *
 * MICA-72 asked for a CHANGELOG that a release could not silently ship without.
 * The obvious form of that check — "does this tag have a section" — is the wrong
 * one here: `release.yml` cuts a CalVer tag on every push to `main`, eleven of
 * them on 2026-08-27 alone and several one commit apart, so a per-tag rule would
 * demand a release note for a chore and would be routed around within a week. A
 * gate that cries wolf gets bypassed, and then it is worse than no gate.
 *
 * So the rule is tied to what an owner must actually *do* rather than to the tag.
 * A versioned migration is the one change that always demands action — the owner
 * has to run `gphoneschema apply` from the server console — and it is detectable
 * from the source. Same shape as `convars.test.ts` and `eventNames.test.ts`: scan
 * for the real thing, then hold the prose to it.
 *
 * The corollary is that a release with no entry is *correct* when nothing
 * owner-affecting shipped. That silence has to be a verified silence rather than
 * an absence, which is what the second block below is for: there are no
 * migrations in the tree yet, so every assertion in the first block passes on an
 * empty set, and AGENTS.md is explicit that a check which cannot run reads as a
 * pass. The probes prove the matcher fires in both directions on known input.
 */
const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'server', 'migrations');
const CHANGELOG = 'CHANGELOG.md';

/**
 * The id of each versioned migration — the filename stem, which is what the
 * runner uses and what `migrationsSeed.test.ts` already pins the filename to.
 * `index.ts` is the generated ordered array, not a migration.
 */
const migrationIds = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith('.ts') && entry !== 'index.ts')
    .map((entry) => entry.replace(/\.ts$/, ''))
    .sort();

/**
 * Pure so the probes below can drive it with input this repo does not have yet.
 * A migration counts as announced if the changelog names its id anywhere; the
 * prose around it is the author's job, not this file's.
 */
const unannounced = (ids: string[], changelog: string): string[] =>
  ids.filter((id) => !changelog.includes(id));

const changelogText = (): string => readFileSync(join(ROOT, CHANGELOG), 'utf8');

/** `## YYYY-MM-DD` section headings, in the order they appear in the file. */
const datedSections = (changelog: string): string[] =>
  [...changelog.matchAll(/^## (\d{4}-\d{2}-\d{2})\s*$/gm)].map((m) => m[1]);

describe('changelog (MICA-72)', () => {
  it('announces every versioned migration', () => {
    const missing = unannounced(migrationIds(), changelogText());

    expect(
      missing,
      `a migration makes an update need \`gphoneschema apply\` — name it in ${CHANGELOG} ` +
        `under "Action required", so an owner reads it before pulling`
    ).toEqual([]);
  });

  // There are no migrations yet, so the assertion above passes on an empty set.
  // These drive the same matcher with input of both kinds, so "no migrations to
  // announce" is a verified silence rather than a regex that quietly matches
  // nothing.
  describe('the check fires, rather than merely being configured', () => {
    const probe = '0001_probe_that_is_not_in_the_changelog';

    it('reports a migration the changelog does not name', () => {
      expect(unannounced([probe], '# Changelog\n\nNothing here.\n')).toEqual([probe]);
    });

    it('accepts one it does', () => {
      expect(unannounced([probe], `# Changelog\n\n- ${probe}: adds a column.\n`)).toEqual([]);
    });

    it('reads the real changelog, so a missing or empty file is a failure', () => {
      // A file this scan cannot read is a file it cannot check. Reading it here
      // means a deleted or truncated CHANGELOG.md fails loudly instead of
      // turning every assertion above into a pass over an empty string.
      expect(changelogText().length).toBeGreaterThan(500);
    });
  });

  describe('stays readable as it grows', () => {
    it('keeps an Unreleased section for work that has not shipped', () => {
      // Without it there is nowhere to write an entry between releases, and the
      // entry gets written after the tag or not at all.
      expect(changelogText()).toMatch(/^## Unreleased\s*$/m);
    });

    it('orders dated sections newest first', () => {
      const dates = datedSections(changelogText());

      expect(dates.length, 'no dated sections found — the heading format changed').toBeGreaterThan(
        0
      );
      expect(dates, 'a reader looking for the newest release reads from the top').toEqual(
        [...dates].sort().reverse()
      );
    });
  });
});
