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
const docblock = fs.readFileSync(NET_GUARD, 'utf8');

const WORDS: Record<string, number> = {
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13
};

const statedNumber = (pattern: RegExp): number => {
  const match = docblock.match(pattern);
  if (!match) throw new Error(`netGuard.ts docblock no longer states: ${pattern}`);
  const word = match[1].toLowerCase();
  if (!(word in WORDS)) throw new Error(`unhandled number word '${word}' in netGuard.ts`);
  return WORDS[word];
};

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

    // The documented pipeline exactly, including its second stage. `grep -v __tests__` is
    // there to drop the test directory, and it also drops this very instruction line out of
    // netGuard's own docblock — which is why the command reports twelve rather than thirteen.
    // Reproducing the quirk is the point: the number in the prose is what a reader will see.
    const rawLines = sourceFiles(SERVER).reduce(
      (total, file) =>
        total +
        fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line.includes('onNet(') && !line.includes('__tests__')).length,
      0
    );

    expect(rawLines).toBe(stated);
    expect(rawLines - handlers.length).toBe(2);
  });
});
