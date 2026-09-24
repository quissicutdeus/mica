// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Summarize CHANGELOG.md into a release's notes body (MICA-221).
 *
 * Before this, `release.yml` handed every release to `gh release create --generate-notes`
 * alone, which is GitHub's auto-generated commit list — the contributor-facing record
 * CHANGELOG.md's own preamble says that list already is. It told an owner nothing about
 * whether the release needs anything from them, which is the one question CHANGELOG.md
 * exists to answer.
 *
 * ## Which entries cover a given tag
 *
 * CHANGELOG.md is not versioned per tag (its preamble explains why: eleven tags were cut on
 * one date alone, and an owner moving across several of them needs one story, not eleven).
 * Structurally the file is one `## Unreleased` section — everything since the last cut,
 * covering however many tags that turns out to be — followed by `## YYYY-MM-DD` sections for
 * dates that *have* been cut, newest first (`server/__tests__/changelog.test.ts` already
 * holds that shape to account).
 *
 * So a tag's coverage is decided the same way a reader would decide it by eye:
 *
 *   1. If a dated section's heading is exactly the tag's date, that section is the release —
 *      this is the "already cut" case, for a tag whose date got its own heading.
 *   2. Otherwise, if the tag's date is newer than every dated section (the common case: no
 *      cut has happened since this tag was pushed), the release is whatever is currently
 *      under `## Unreleased` — the open, not-yet-dated period this tag falls inside.
 *   3. Otherwise the tag's date falls strictly between two dated sections, or before the
 *      oldest one, with no heading of its own. Per the preamble, "a release with no entry
 *      means there was nothing for an owner to do" — that is a legitimate, expected outcome,
 *      not a bug, so this says so explicitly rather than emitting nothing.
 *
 * A structural surprise — no `## Unreleased` heading, a non-dated heading after it, or dated
 * headings out of newest-first order — is different from "no entry": it means this script's
 * model of the file is wrong, so it throws rather than guessing. An empty or missing
 * CHANGELOG.md fails the same way, at `readFileSync` in the caller. Nothing here ever returns
 * an empty string.
 */

const HEADING_RE = /^## (.+?) *$/gm;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAG_RE = /^v(\d{4})\.(\d{2})\.(\d{2})\.\d+$/;

/**
 * The most CHANGELOG text a release body carries before it is cut and pointed at the full
 * entry instead. GitHub rejects a release body over 125,000 characters, and
 * `--generate-notes`' own commit list is appended after this (`release.yml`) — three weeks
 * of commits plus an Unreleased section that had grown to 73,175 characters is what forced
 * the question. 40,000 leaves the commit list ample room and is still generous for prose.
 */
export const MAX_ENTRY_CHARS = 40000;

/**
 * Split CHANGELOG.md's body into its top-level `## ` sections, in file order.
 *
 * @param {string} changelogText
 * @returns {{ heading: string, body: string }[]}
 */
export function parseSections(changelogText) {
  const matches = [...changelogText.matchAll(HEADING_RE)];
  if (matches.length === 0) {
    throw new Error('no "## " section headings found — is this really CHANGELOG.md?');
  }
  return matches.map((match, i) => {
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : changelogText.length;
    return { heading: match[1].trim(), body: changelogText.slice(start, end).trim() };
  });
}

/**
 * Validate the Unreleased + newest-first-dated shape and split it into its two halves.
 *
 * @param {string} changelogText
 * @returns {{ unreleased: { heading: string, body: string }, dated: { heading: string, body: string }[] }}
 */
function structuredSections(changelogText) {
  const sections = parseSections(changelogText);
  const [unreleased, ...rest] = sections;

  if (unreleased.heading !== 'Unreleased') {
    throw new Error(
      `expected the first "## " section to be "Unreleased", found "## ${unreleased.heading}" — ` +
        'the file structure changed and this script no longer knows where open entries live.'
    );
  }

  for (const section of rest) {
    if (!DATE_RE.test(section.heading)) {
      throw new Error(
        `expected a dated "## YYYY-MM-DD" heading after Unreleased, found "## ${section.heading}".`
      );
    }
  }

  const dates = rest.map((s) => s.heading);
  const newestFirst = [...dates].sort().reverse();
  if (dates.some((d, i) => d !== newestFirst[i])) {
    throw new Error(
      'dated sections are not in newest-first order — cannot tell which release a tag ' +
        'between two of them belongs to.'
    );
  }

  return { unreleased, dated: rest };
}

/**
 * The wording used whenever no CHANGELOG entry applies to a release. Deliberately explicit —
 * see the preamble in CHANGELOG.md: silence here is a checked, intentional state, not an
 * omission.
 */
export const NOTHING_FOR_OWNER =
  "No CHANGELOG entry applies to this release. Per this file's own rule, that means there " +
  'was nothing here for a server owner to do, and nothing an add-on author needs to react to ' +
  '— no schema change, no renamed command or export, no convar.';

/**
 * Resolve which section (if any) covers a tag, per the three cases in the header comment.
 *
 * @param {string} tag a CalVer tag, `vYYYY.MM.DD.N`
 * @param {string} changelogText
 * @returns {{ coverage: 'dated' | 'unreleased' | 'none', body: string }}
 */
export function resolveSection(tag, changelogText) {
  const tagMatch = TAG_RE.exec(tag);
  if (!tagMatch) {
    throw new Error(`"${tag}" is not a CalVer tag of the form vYYYY.MM.DD.N.`);
  }
  const [, y, m, d] = tagMatch;
  const tagDate = `${y}-${m}-${d}`;

  const { unreleased, dated } = structuredSections(changelogText);

  const exact = dated.find((s) => s.heading === tagDate);
  if (exact) {
    return { coverage: 'dated', body: exact.body };
  }

  const newestDated = dated[0]?.heading ?? null;
  if (newestDated === null || tagDate > newestDated) {
    return { coverage: 'unreleased', body: unreleased.body };
  }

  return { coverage: 'none', body: '' };
}

/**
 * Cut an over-long CHANGELOG entry down to `max` characters, at a `### ` subsection boundary
 * where the entry has one and a blank-line paragraph boundary otherwise — never mid-sentence.
 *
 * `### For add-on authors` is treated specially: it is pulled out before the cut and
 * re-appended afterward whenever it still fits, even if earlier main-section content had to
 * be dropped to make room. It answers a different reader than the rest of the entry, and it
 * is reliably short, so losing it to a cut made room for prose earlier in the entry would
 * lose the one part an add-on author is actually looking for.
 *
 * @param {string} body
 * @param {string} tag
 * @param {string} repo `owner/repo`, for the "full entry" link
 * @param {number} [max]
 * @returns {string}
 */
export function capEntry(body, tag, repo, max = MAX_ENTRY_CHARS) {
  if (body.length <= max) return body;

  const ADDON_RE = /\n(### For add-on authors\b[\s\S]*?)(?=\n### |\n*$)/;
  const addonMatch = ADDON_RE.exec(body);
  const addon = addonMatch ? addonMatch[1].trim() : null;
  const main = addon ? body.slice(0, addonMatch.index).trimEnd() : body;

  // Prefer cutting between "### " subsections; fall back to blank-line paragraphs when the
  // entry (or the fixture driving a test) has no subsections at all.
  const boundaryRe = /^### .*$/m.test(main) ? /\n(?=### )/ : /\n\n+/;
  const units = main
    .split(boundaryRe)
    .map((u) => u.trim())
    .filter(Boolean);

  const link = `See the full entry: https://github.com/${repo}/blob/${tag}/CHANGELOG.md`;
  // Reserve room for the addon section up front, not just the link -- otherwise the main-
  // content loop below fills right up to `max` and there is nothing left to append it to.
  const reserved = link.length + 2 + (addon ? addon.length + 2 : 0);
  const budget = max - reserved;

  let kept = '';
  for (const unit of units) {
    const candidate = kept ? `${kept}\n\n${unit}` : unit;
    if (candidate.length > budget) break;
    kept = candidate;
  }
  // Only reachable if a single subsection alone busts the budget -- still never over `max`.
  if (kept.length === 0) kept = units[0].slice(0, Math.max(budget, 0));

  let result = `${kept}\n\n${link}`;
  if (addon && result.length + 2 + addon.length <= max) {
    result = `${result}\n\n${addon}`;
  }
  return result;
}

/**
 * The full release notes body for a tag: the applicable CHANGELOG entry (or the explicit
 * "nothing for an owner" line), capped at `MAX_ENTRY_CHARS`, plus a pointer to installing and
 * verifying the release. `release.yml` prepends this to `gh release create
 * --generate-notes`'s own output, so the commit list stays available underneath it.
 *
 * @param {string} tag a CalVer tag, `vYYYY.MM.DD.N`
 * @param {string} changelogText the raw contents of CHANGELOG.md
 * @param {string} [repo] `owner/repo`, for the install/verify links
 * @returns {string}
 */
export function releaseNotesFor(tag, changelogText, repo = 'quissicutdeus/mica') {
  const { body } = resolveSection(tag, changelogText);
  const entry = capEntry(body.length > 0 ? body : NOTHING_FOR_OWNER, tag, repo);

  const footer = [
    '---',
    '',
    `Install or update: see [Installation & Setup](https://github.com/${repo}#installation--setup) ` +
      'in the README.',
    '',
    'Verify the attached assets before installing:',
    '',
    '```sh',
    'sha256sum -c --ignore-missing SHA256SUMS',
    `gh attestation verify <asset> --repo ${repo}`,
    '```'
  ].join('\n');

  return `${entry}\n\n${footer}\n`;
}
