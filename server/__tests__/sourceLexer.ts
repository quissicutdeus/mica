// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The TypeScript lexer `genericCrudCallers.test.ts` gates on, for a second scanner (MICA-433,
 * `logHygiene.test.ts`). Copied rather than moved so the suite that proved it (MICA-414) keeps
 * its own copy untouched; the two must stay in step, and the fixtures in each prove theirs.
 */

/**
 * A source file as the scan reads it, three ways, all the same length so an index into one is an
 * index into the others:
 *
 * - `text` — comments blanked, strings kept: what the call patterns match against.
 * - `code` — strings, template text and regex literals blanked too: where a paren, or the start
 *   of a match, is code rather than something quoted.
 * - `ok` — false when the lexer met something it could not close (a string, a template, a block
 *   comment). Such a file credits nothing, so a lexer that lost its place reports live events as
 *   uncalled rather than crediting whatever text it misread.
 */
export type Read = { text: string; code: string; ok: boolean };

/** Words after which a `/` opens a regex literal rather than dividing. */
const REGEX_AFTER = new Set(
  'return typeof instanceof in of new delete void throw case do else yield await'.split(' ')
);

/**
 * Lex TypeScript just far enough to tell code from strings and comments.
 *
 * Every string honours `\` escapes — skipping to the next quote character closed `'it\'s'` at
 * the escaped quote, and the rest of the file read inside out, so a call's argument bound ran on
 * past its own `)` and credited a neighbour's actions to it. Template literals resume code at
 * `${` and return to text at its matching `}`. A comment is only a comment outside a string, so
 * `'assets/*.png'` no longer swallows the code up to the next `*\/`, and `x();// …` (no space
 * before the slashes) is a comment, where the old whitespace-anchored pattern kept it as code.
 */
export const lexScript = (src: string): Read => {
  const text = src.split('');
  const code = src.split('');
  const blank = (to: string[], from: number, end: number) => {
    for (let k = from; k < end; k++) if (to[k] !== '\n') to[k] = ' ';
  };
  const fail: Read = { text: src, code: src, ok: false };
  const resume: number[] = []; // the brace depth each open `${` closes back to
  let depth = 0;
  let prev = ''; // the last token: a word, a punctuation character, or 'value'

  // From inside a template's text: past its closing backtick, or past a `${`; -1 if neither.
  const templateEnd = (from: number): number => {
    for (let j = from; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '`') return j + 1;
      else if (src[j] === '$' && src[j + 1] === '{') {
        resume.push(depth++);
        return j + 2;
      }
    }
    return -1;
  };
  // Past a regex literal's flags, or -1 when the line ends first — it was a division.
  const regexEnd = (from: number): number => {
    let inClass = false;
    for (let j = from + 1; j < src.length && src[j] !== '\n'; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '[') inClass = true;
      else if (src[j] === ']') inClass = false;
      else if (src[j] === '/' && !inClass) {
        for (j++; j < src.length && /[a-z]/i.test(src[j]!); j++);
        return j;
      }
    }
    return -1;
  };

  for (let i = 0; i < src.length;) {
    const ch = src[i]!;
    if (ch === '/' && src[i + 1] === '/') {
      const newline = src.indexOf('\n', i);
      const end = newline < 0 ? src.length : newline;
      blank(text, i, end);
      blank(code, i, end);
      i = end;
    } else if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) return fail;
      blank(text, i, close + 2);
      blank(code, i, close + 2);
      i = close + 2;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] !== ch) return fail;
      blank(code, i, j + 1);
      i = j + 1;
      prev = 'value';
    } else if (ch === '`' || (ch === '}' && depth - 1 === resume.at(-1))) {
      if (ch === '}') depth = resume.pop()!;
      const end = templateEnd(i + 1);
      if (end < 0) return fail;
      blank(code, i, end);
      i = end;
      prev = src[end - 1] === '`' ? 'value' : '{';
    } else if (
      ch === '/' &&
      (/^[\w$]+$/.test(prev) ? REGEX_AFTER.has(prev) : !['value', ')', ']'].includes(prev))
    ) {
      const end = regexEnd(i);
      if (end < 0) {
        prev = '/';
        i++;
      } else {
        blank(code, i, end);
        i = end;
        prev = 'value';
      }
    } else if (/[\w$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      prev = src.slice(i, j);
      i = j;
    } else {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
  }
  return resume.length > 0 ? fail : { text: text.join(''), code: code.join(''), ok: true };
};
