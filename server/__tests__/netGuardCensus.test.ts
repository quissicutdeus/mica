// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The `onNet` census in `lib/netGuard.ts`'s docblock, checked against the tree.
 *
 * That comment defines the two categories of raw `onNet` handler and is where anyone auditing
 * gPhone's entry points starts. It has now been wrong twice: once when it said eight handlers
 * across three files and named a file with no `onNet` at all, and again when MICA-150 moved
 * `Settings.ts` and `Battery.ts` onto a subscription and left it claiming twelve handlers in
 * three named files, two of which no longer participate.
 *
 * The comment already prescribes its own fix — "Recount rather than trusting this comment,
 * which has been wrong before" — and a recount nobody runs is a check that fails open. So this
 * runs it. It reads the numbers **out of the docblock** rather than restating them, so what is
 * asserted is "the comment is true" rather than a second copy of the count that can drift from
 * the first. Change the handlers without changing the prose and this fails, which is the only
 * reason the prose can be trusted at all.
 */

const SERVER = path.join(__dirname, '..');
const NET_GUARD = path.join(SERVER, 'lib', 'netGuard.ts');
const SECURITY_DOC = path.join(SERVER, '..', 'docs', 'security.md');

const docblock = fs.readFileSync(NET_GUARD, 'utf8');
const securityDoc = fs.readFileSync(SECURITY_DOC, 'utf8');

const WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13
};

/**
 * A number the prose states, in words, pulled out of the prose itself.
 *
 * Both copies of the census are read this way rather than restated here, so what is asserted
 * is "this file is true" — a third copy in the test could drift from both and would be the
 * one nobody thinks to check.
 *
 * A pattern that stops matching **throws** rather than skipping. These are emptiness-shaped
 * assertions, and an emptiness-shaped assertion that quietly finds nothing is a check that
 * passes forever while guarding nothing.
 */
const stated = (text: string, where: string, pattern: RegExp, group = 1): number => {
  const match = text.match(pattern);
  if (!match) {
    throw new Error(
      `${where} no longer states its census in a checkable form. Expected to find ` +
        `${pattern}. The count is gated because both copies have been wrong before; if the ` +
        'wording has to change, change this pattern with it rather than deleting the check.'
    );
  }
  const word = match[group].toLowerCase();
  if (!(word in WORDS)) throw new Error(`unhandled number word '${word}' in ${where}`);
  return WORDS[word];
};

const statedNumber = (pattern: RegExp): number => stated(docblock, 'netGuard.ts', pattern);

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

/**
 * A real registration, as opposed to the two things the raw grep also returns.
 *
 * `ServiceEndpoint.ts`'s generic registrar passes a bare `eventName` variable, so requiring a
 * string literal or a SCREAMING_CASE constant excludes it without this test having to name the
 * file. The worked example in netGuard's own docblock is a string literal, so comment lines are
 * skipped instead.
 */
const registrations = (): { file: string; event: string }[] => {
  const found: { file: string; event: string }[] = [];

  for (const file of sourceFiles(SERVER)) {
    const relative = path.relative(SERVER, file);
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

      const literal = line.match(/\bonNet\(\s*['"]([^'"]+)['"]/);
      if (literal) {
        found.push({ file: relative, event: literal[1] });
        continue;
      }
      const constant = line.match(/\bonNet\(\s*([A-Z][A-Z0-9_]*\.[A-Za-z0-9_]+)/);
      if (constant) found.push({ file: relative, event: constant[1] });
    }
  }

  return found;
};

/** gPhone's own namespace. Anything else is named by a framework, which is the whole point. */
const isGphoneNamed = (event: string) => event.startsWith('gphone:');

/**
 * What the documented command actually prints, reproduced including its second stage.
 *
 * `grep -v __tests__` is there to drop the test directory, and it also drops the copy of the
 * command inside `netGuard.ts`'s own docblock, which matches `onNet(` and is filtered out only
 * because it quotes `__tests__`. That is why the command reports twelve lines rather than
 * thirteen. Reproducing the quirk is the point: both the docblock and `docs/security.md` tell
 * a reader what they will see, so the number has to be what the pipeline really prints.
 */
const rawGrepLines = (): number =>
  sourceFiles(SERVER).reduce(
    (total, file) =>
      total +
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.includes('onNet(') && !line.includes('__tests__')).length,
    0
  );

describe('the onNet census in netGuard.ts is true', () => {
  const handlers = registrations();

  it('finds the number of handlers the docblock claims', () => {
    const stated = statedNumber(/(\w+) handlers are raw `onNet` listeners/);

    expect(
      handlers.length,
      `netGuard.ts says ${stated} raw onNet handlers; the tree has ${handlers.length}:\n` +
        handlers.map((h) => `  ${h.file}  ${h.event}`).join('\n')
    ).toBe(stated);
  });

  it('finds the number of gphone-named handlers the docblock claims', () => {
    const stated = statedNumber(/(\w+) are gphone-named/);
    expect(handlers.filter((h) => isGphoneNamed(h.event))).toHaveLength(stated);
  });

  it('finds them in exactly the files the docblock names', () => {
    // The prose lists the gphone-named files inline. A handler in a fifth file is an entry
    // point nobody has audited, which is how this comment went wrong the first time.
    // Up to the backtick that is followed by the sentence's full stop. A naive `[^.]+`
    // stops at the dot inside `Phone.ts` and captures nothing.
    const sentence = docblock.match(/are gphone-named, across ([\s\S]*?`)\./);
    expect(sentence, 'netGuard.ts no longer lists the gphone-named files').not.toBeNull();

    const named = [...sentence![1].matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
    const actual = [
      ...new Set(handlers.filter((h) => isGphoneNamed(h.event)).map((h) => path.basename(h.file)))
    ].sort();

    expect(actual).toEqual(named);
  });

  it('has exactly one framework-named handler, in shell.ts', () => {
    // Three, before MICA-150 — `Settings.ts` and `Battery.ts` each pasted the same listener,
    // which is why all three carried MICA-136's payload bug simultaneously. They subscribe
    // through `onPlayerLoaded` now and register nothing, so this is the whole category.
    const framework = handlers.filter((h) => !isGphoneNamed(h.event));

    expect(framework.map((h) => h.file)).toEqual([path.join('lib', 'shell.ts')]);
  });

  it('counts the two grep results that are not handlers', () => {
    // The docblock warns a reader that the raw grep returns more lines than there are
    // handlers. If that gap changes, the instruction it gives becomes misleading.
    const stated = statedNumber(/That returns (\w+)/);

    const rawLines = rawGrepLines();

    expect(rawLines).toBe(stated);
    expect(rawLines - handlers.length).toBe(2);
  });
});

/**
 * The same census, where a security auditor actually reads it.
 *
 * `docs/security.md` is the human-readable entry-point inventory and states these numbers
 * too. Until now only `netGuard.ts` was gated, so the next drift would land silently in the
 * page — the copy a reader treats as authoritative. `changelog.test.ts` already sets the
 * precedent for a server test holding a markdown file to something, and for the same reason:
 * some documents are load-bearing enough that being wrong is worse than being absent.
 *
 * **It reads the page's own sentences, and does not ask the page to carry a separate table
 * of digits for the test's benefit.** A table would be a third copy of the census, sitting
 * beside prose that says the same thing in words — and the gate would hold the table while
 * the prose, which is the part anyone actually reads, drifted freely. That is the hole this
 * suite exists to close, reintroduced one level down.
 *
 * **What makes the prose safe to read is that these four claims are structural, not
 * narrative.** Two are `####` headings and two are bold lead-ins, and every number in the
 * page's *narrative* is deliberately excluded by that anchoring — `docs/security.md:88-89`
 * says the census "used to read six" and that "three gphone-named handlers had been added
 * since it was written", and `:156` says "This was three until ESX support landed". All
 * three are true sentences about the past. An unanchored scan for number-words would read
 * them as current claims and punish the page for being well written; these patterns cannot
 * match them, which is asserted below rather than asserted about.
 */
describe('the onNet census in docs/security.md is true', () => {
  const handlers = registrations();
  const gphoneNamed = handlers.filter((h) => isGphoneNamed(h.event));
  const frameworkNamed = handlers.filter((h) => !isGphoneNamed(h.event));

  const inDoc = (pattern: RegExp, group = 1) =>
    stated(securityDoc, 'docs/security.md', pattern, group);

  /** `**Ten, across five files**` — the section's opening claim. */
  const TOTAL_AND_FILES = /\*\*(\w+), across (\w+) files\*\*/;
  /** `**That prints twelve lines for ten handlers.**` */
  const PRINTS = /\*\*That prints (\w+) lines for (\w+) handlers\.\*\*/;
  /** `#### gphone-named — nine, every one guarded` */
  const MICA_HEADING = /^#### gphone-named — (\w+)/m;
  /** `#### Framework-named — one, and this is the category that was missing` */
  const FRAMEWORK_HEADING = /^#### Framework-named — (\w+)/m;

  it('opens the section with the handler total and file count the tree has', () => {
    const files = new Set(handlers.map((h) => h.file));

    expect(inDoc(TOTAL_AND_FILES)).toBe(handlers.length);
    expect(inDoc(TOTAL_AND_FILES, 2)).toBe(files.size);
  });

  it('states what its own grep prints, and how many of those are handlers', () => {
    // The page tells a reader to count from the tree and then says what they will see. If
    // either number is wrong the instruction is worse than no instruction, because following
    // it produces a mismatch the reader has no way to resolve.
    expect(inDoc(PRINTS, 2)).toBe(handlers.length);
    expect(inDoc(PRINTS)).toBe(rawGrepLines());
  });

  it('heads each category with the count the tree has', () => {
    expect(inDoc(MICA_HEADING)).toBe(gphoneNamed.length);
    expect(inDoc(FRAMEWORK_HEADING)).toBe(frameworkNamed.length);
  });

  it('agrees with netGuard.ts, so the two copies cannot drift apart', () => {
    // Both are already checked against the tree, so this is redundant arithmetic — and it is
    // the assertion whose failure message says the useful thing, because "the page and the
    // comment disagree" is what a reader actually experiences.
    expect(inDoc(TOTAL_AND_FILES)).toBe(statedNumber(/(\w+) handlers are raw `onNet` listeners/));
    expect(inDoc(MICA_HEADING)).toBe(statedNumber(/(\w+) are gphone-named/));
  });

  const ANCHORS = { TOTAL_AND_FILES, PRINTS, MICA_HEADING, FRAMEWORK_HEADING };

  /** The same pattern, global, so every occurrence in the page can be counted. */
  const occurrences = (pattern: RegExp) => [
    ...securityDoc.matchAll(new RegExp(pattern.source, pattern.flags + 'g'))
  ];

  it('reserves each of the four shapes for exactly one place in the page', () => {
    // This is what makes reading prose safe, and it replaces an earlier version that listed
    // the three narrative sentences the anchors must avoid. That version was weaker and
    // costlier at once. Weaker, because it only proved the anchors missed the narrative that
    // existed when it was written: a *new* sentence taking one of these shapes would still
    // have been matched, and `.match()` returns the first hit, so the gate would have begun
    // reading its number out of a sentence about the past. Costlier, because it also
    // asserted those three sentences were still present verbatim, which held them against
    // rewording and made "the narrative is free to change" untrue.
    //
    // Counting occurrences in the real page fixes both at once. Any narrative that ever
    // takes one of these shapes makes the count two and fails here, whatever it says; and
    // nothing in the page is pinned except the four claims themselves.
    for (const [name, pattern] of Object.entries(ANCHORS)) {
      expect(
        occurrences(pattern),
        `${name} should match exactly one place in docs/security.md. Two means a sentence ` +
          'has taken a reserved shape and the gate can no longer tell which one is the ' +
          'claim; zero means the claim was reworded out of its shape.'
      ).toHaveLength(1);
    }
  });

  it('reserves the four shapes, and not the words around them', () => {
    // Illustrative constructions, deliberately **not** quotations from the page: nothing
    // here is pinned, and rewriting the narrative cannot fail this. They are the shapes most
    // likely to collide - a sentence about a past count, a bold sentence carrying a number,
    // and a count in plain prose without the bold markers the anchor requires.
    const narrative = [
      'The census used to read six, in two files, and it was wrong in both directions.',
      'Two gphone-named handlers had been added since that paragraph was written.',
      '**This was three until ESX support landed, and the drop was a real reduction.**',
      'There are ten handlers here, across five files, if you would rather count by hand.'
    ];

    for (const line of narrative) {
      for (const [name, pattern] of Object.entries(ANCHORS)) {
        expect(pattern.test(line), `${name} must not match narrative: ${line}`).toBe(false);
      }
    }
  });
});
