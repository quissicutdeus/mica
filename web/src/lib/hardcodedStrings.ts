// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Find user-facing English literals in a Svelte file (MICA-61).
 *
 * A scanner, not a parser, and honest about what that covers: text nodes in the template
 * (outside `{…}` expressions), the attributes a player reads (`placeholder`, `title`,
 * `aria-label`, `alt`, `label`, `message`, `description`, `footer`, `confirmText`,
 * `cancelText`), and — in the script — a string literal handed to the keys a toast or a
 * dialog reads (`success`, `error`, `title`, `message`, `label`). A literal in any other
 * position is invisible to it, which is why the ratchet in `hardcodedStrings.test.ts` is a
 * floor on the obvious cases rather than proof of a fully translated file.
 *
 * "User-facing" is "has two letters in a row". Symbols, numbers, class strings and single
 * letters (the `B` on a Bold button) pass.
 */
export interface HardcodedString {
  line: number;
  text: string;
}

const READ_ATTRIBUTES = [
  'placeholder',
  'title',
  'aria-label',
  'alt',
  'label',
  'message',
  'description',
  'footer',
  'confirmText',
  'cancelText'
];
const SCRIPT_KEYS = ['success', 'error', 'title', 'message', 'label'];

const looksLikeProse = (text: string): boolean => /[A-Za-z]{2,}/.test(text);

/** Replace every `{…}` expression (nesting-aware) with spaces, keeping line numbers. */
const blankExpressions = (text: string): string => {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '{') depth++;
    if (depth > 0) out += ch === '\n' ? '\n' : ' ';
    else out += ch;
    if (ch === '}' && depth > 0) depth--;
  }
  return out;
};

const blankRanges = (text: string, pattern: RegExp): string =>
  text.replace(pattern, (m) => m.replace(/[^\n]/g, ' '));

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

export function findHardcodedStrings(source: string): HardcodedString[] {
  const found: HardcodedString[] = [];
  const push = (index: number, text: string) => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (looksLikeProse(trimmed)) found.push({ line: lineOf(source, index), text: trimmed });
  };

  // The script, first: only the keys a player reads.
  const scripts = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  for (const script of scripts) {
    const body = script[1];
    const offset = script.index! + script[0].indexOf(body);
    const keys = SCRIPT_KEYS.join('|');
    for (const m of body.matchAll(
      new RegExp(`\\b(?:${keys})\\s*:\\s*(['"\`])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`, 'g')
    )) {
      push(offset + m.index!, m[2]);
    }
  }

  // The template: strip script, style and comments (keeping line numbers), then read.
  let template = blankRanges(
    source,
    /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g
  );
  template = blankExpressions(template);

  const attrs = READ_ATTRIBUTES.join('|');
  for (const m of template.matchAll(new RegExp(`\\b(?:${attrs})=(["'])([^"']*)\\1`, 'g'))) {
    push(m.index!, m[2]);
  }
  // Text nodes: whatever sits between a `>` and the next `<`.
  for (const m of template.matchAll(/>([^<>]+)</g)) {
    push(m.index! + 1, m[1]);
  }
  return found;
}
