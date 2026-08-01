import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * An app with internal levels has to claim the `back` action.
 *
 * The shell owns Backspace. Wiring a `goBack` to `<Screen onback>` alone is not enough —
 * the shell's handler runs instead and the key jumps straight home, skipping whatever
 * level the player was on.
 *
 * Notes and Contacts shipped exactly that way: both defined a multi-level `goBack` and
 * neither registered it, so Backspace left the app instead of closing the open note or
 * contact. Nothing caught it because the two wirings are independent.
 */

const ROOT = join(__dirname, '..', '..');
const APPS = join(ROOT, 'src', 'apps');

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.svelte')) out.push(full);
  }
  return out;
};

/** A `goBack` that can do more than leave — i.e. one with a branch. */
const hasLevels = (text: string): boolean => {
  const at = text.search(/const\s+goBack\s*=/);
  if (at === -1) return false;
  // Look at the function body: a bare `onback?.()` is a one-liner with no levels.
  const body = text.slice(at, at + 600);
  return /\bif\s*\(/.test(body);
};

const FILES = walk(APPS);

describe('back navigation', () => {
  it('finds app files to check', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it('every app with a multi-level goBack also claims the back action', () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      if (!hasLevels(text)) continue;
      if (!/onKeybind\(\s*['"]back['"]/.test(text)) {
        offenders.push(relative(ROOT, file));
      }
    }

    expect(
      offenders.sort(),
      'define goBack and register it with onKeybind("back") — the shell owns Backspace ' +
        'and will otherwise pre-empt it, sending the player home from a detail view'
    ).toEqual([]);
  });
});
