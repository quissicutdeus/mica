// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  parseSections,
  resolveSection,
  releaseNotesFor,
  capEntry,
  MAX_ENTRY_CHARS,
  NOTHING_FOR_OWNER
} from '../../scripts/lib/release-notes.js';

/**
 * `scripts/release-notes.js` summarizes CHANGELOG.md into a release's notes body (MICA-221),
 * so `release.yml` no longer hands a release to GitHub's auto-generated commit list alone.
 *
 * The fixture below is a small stand-in for CHANGELOG.md's real shape — one `## Unreleased`
 * section plus two `## YYYY-MM-DD` sections, newest first — so the three coverage cases in
 * `lib/release-notes.js`'s header comment can each be driven directly, without depending on
 * whatever the real file happens to say on the day this runs. The tests against the real file
 * below are the ones that would notice if that shape ever changed.
 */

const ROOT = resolve(__dirname, '../..');

const FIXTURE = `# Changelog

Preamble prose nobody parses.

## Unreleased

### Action required

None.

### Added

- Something not yet cut into a dated section.

## 2026-09-10

### Action required

- Run \`micaschema apply\` (MICA-999).

### For add-on authors

- The manifest gained a field.

## 2026-08-27

This file starts here.

### Action required

None.
`;

describe('parseSections', () => {
  it('splits on top-level headings, keeping each body trimmed', () => {
    const sections = parseSections(FIXTURE);

    expect(sections.map((s: { heading: string }) => s.heading)).toEqual([
      'Unreleased',
      '2026-09-10',
      '2026-08-27'
    ]);
    expect(sections[1].body).toContain('micaschema apply');
    expect(sections[1].body).toContain('For add-on authors');
  });

  it('throws rather than returning nothing when there are no headings at all', () => {
    expect(() => parseSections('# Changelog\n\nno sections here\n')).toThrow(/no "## "/);
  });
});

describe('resolveSection', () => {
  it('picks the dated section when the tag lands exactly on one — the "already cut" case', () => {
    const { coverage, body } = resolveSection('v2026.09.10.1', FIXTURE);

    expect(coverage).toBe('dated');
    expect(body).toContain('MICA-999');
  });

  it('falls back to Unreleased when the tag is newer than every dated section', () => {
    const { coverage, body } = resolveSection('v2026.09.23.4', FIXTURE);

    expect(coverage).toBe('unreleased');
    expect(body).toContain('not yet cut into a dated section');
  });

  it('reports no entry when the tag falls in a gap between two dated sections', () => {
    // 2026-09-01 is after 2026-08-27 and before 2026-09-10, and got no heading of its own —
    // exactly the "a release with no entry means nothing for an owner to do" case.
    const { coverage, body } = resolveSection('v2026.09.01.1', FIXTURE);

    expect(coverage).toBe('none');
    expect(body).toBe('');
  });

  it('rejects anything that is not a vYYYY.MM.DD.N tag', () => {
    expect(() => resolveSection('2026.09.10.1', FIXTURE)).toThrow(/CalVer tag/);
    expect(() => resolveSection('v2026.09.10', FIXTURE)).toThrow(/CalVer tag/);
  });

  it('fails loudly rather than guessing when Unreleased is missing', () => {
    const broken = FIXTURE.replace('## Unreleased', '## Not Unreleased');

    expect(() => resolveSection('v2026.09.23.1', broken)).toThrow(/Unreleased/);
  });

  it('fails loudly on a non-dated heading after Unreleased', () => {
    const broken = FIXTURE.replace('## 2026-09-10', '## Whoops');

    expect(() => resolveSection('v2026.09.23.1', broken)).toThrow(/dated "## YYYY-MM-DD"/);
  });

  it('fails loudly when dated sections are not newest-first', () => {
    const broken = FIXTURE.replace(
      /## 2026-09-10([\s\S]*?)## 2026-08-27/,
      '## 2026-08-27$1## 2026-09-10'
    );

    expect(() => resolveSection('v2026.09.23.1', broken)).toThrow(/newest-first order/);
  });
});

describe('capEntry', () => {
  const repo = 'quissicutdeus/mica';
  const tag = 'v2026.09.23.1';
  const link = `https://github.com/${repo}/blob/${tag}/CHANGELOG.md`;

  it('leaves a body at or under the cap byte-for-byte untouched', () => {
    const body = `### Added\n\n${'a'.repeat(MAX_ENTRY_CHARS - 20)}`;

    expect(capEntry(body, tag, repo)).toBe(body);
  });

  it('cuts an over-limit entry at a section boundary and links the full entry', () => {
    const marker = 'THIS SHOULD BE CUT';
    const big = [
      '### Action required',
      '',
      'a'.repeat(30000),
      '',
      '### Added',
      '',
      `${marker}\n${'b'.repeat(30000)}`,
      '',
      '### For add-on authors',
      '',
      'The manifest gained a field.'
    ].join('\n');
    expect(big.length).toBeGreaterThan(MAX_ENTRY_CHARS);

    const result = capEntry(big, tag, repo);

    expect(result.length).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
    expect(result).toContain('### Action required');
    expect(result).not.toContain(marker);
    expect(result).toContain(link);
    // Kept even though the section ahead of it was dropped -- a different, short reader.
    expect(result).toContain('### For add-on authors');
  });

  it('falls back to paragraph boundaries when the entry has no subsections', () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}. ${'p'.repeat(3000)}`);
    const big = paragraphs.join('\n\n');
    expect(big.length).toBeGreaterThan(MAX_ENTRY_CHARS);

    const result = capEntry(big, tag, repo);

    expect(result.length).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
    expect(result).toContain('Paragraph 0.');
    expect(result).not.toContain('Paragraph 19.');
    expect(result).toContain(link);
  });
});

describe('releaseNotesFor', () => {
  it('emits the explicit "nothing for an owner" line when no entry applies', () => {
    const notes = releaseNotesFor('v2026.09.01.1', FIXTURE);

    expect(notes).toContain(NOTHING_FOR_OWNER);
    expect(notes).toContain('Installation & Setup');
  });

  it('never returns an empty string, even when the matched section has no body', () => {
    const bare = FIXTURE.replace(
      /## Unreleased[\s\S]*?## 2026-09-10/,
      '## Unreleased\n\n## 2026-09-10'
    );

    const notes = releaseNotesFor('v2026.09.23.1', bare);

    expect(notes.trim().length).toBeGreaterThan(0);
    expect(notes).toContain(NOTHING_FOR_OWNER);
  });

  it('links install and verify instructions to the given repo', () => {
    const notes = releaseNotesFor('v2026.09.10.1', FIXTURE, 'someone/fork');

    expect(notes).toContain('https://github.com/someone/fork#installation--setup');
    expect(notes).toContain('gh attestation verify <asset> --repo someone/fork');
  });

  it('parses the real CHANGELOG.md without throwing, for a tag newer than every dated section', () => {
    // Every dated section in the real file is historical; today's work still lives under
    // Unreleased, so this exercises the same "open period" branch every push-to-main release
    // actually takes right now.
    const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');

    const notes = releaseNotesFor('v2099.01.01.1', changelog);

    expect(notes.length).toBeGreaterThan(0);
    expect(notes).toContain('Installation & Setup');
  });

  it('reads a historical dated section out of the real CHANGELOG.md', () => {
    const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');

    const { coverage, body } = resolveSection('v2026.08.27.1', changelog);

    expect(coverage).toBe('dated');
    expect(body).toContain('This file starts here');
  });
});
