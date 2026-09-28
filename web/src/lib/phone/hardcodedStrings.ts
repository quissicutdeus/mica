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
 *
 * MICA-291 widened this to look *inside* an `aria-label={…}` / `title={…}` expression too —
 * `aria-label={open ? 'Close X' : 'Open X'}` used to be invisible outright, because the
 * whole `{…}` span is blanked before the attribute regex ever runs (`blankExpressions`
 * exists so a `{` in a ternary doesn't get mistaken for a JSX-like attribute boundary). The
 * accessible name a screen reader speaks does not care whether it came from a plain quoted
 * attribute or a ternary inside one, so both must be seen. The one thing that has to be
 * excluded is a `$t('shell.someKey')` call already inside that expression — its argument is
 * a catalog key, not prose, and would otherwise ratchet the count back up forever — so those
 * calls are blanked out first, the same way script/style/comments are.
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

/** The `label: 'Text'` shape, for the keys a player reads, over a stretch of script. */
const SCRIPT_LITERALS = new RegExp(
  `\\b(?:${SCRIPT_KEYS.join('|')})\\s*:\\s*(['"\`])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`,
  'g'
);

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

/** The attributes whose *expression* (not just a plain quoted value) is worth opening. */
const BRACED_ATTRS = ['title', 'aria-label'];

/** Any quoted literal — unlike `SCRIPT_LITERALS`, not anchored to a preceding key. */
const QUOTED_LITERAL = /(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;

/** A comparison operator butting up against one edge of a literal, trailing/leading whitespace aside. */
const COMPARISON_BEFORE = /(?:===|!==|==|!=|<=|>=|[<>])\s*$/;
const COMPARISON_AFTER = /^\s*(?:===|!==|==|!=|<=|>=|[<>])/;

/** Index of the bracket in `close` that balances the one at `openIndex`, or -1. */
const matchBalanced = (text: string, openIndex: number, open: string, close: string): number => {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Blank every balanced `(...)` call whose head matches `pattern`, keeping length and lines. */
const blankCalls = (text: string, pattern: RegExp): string => {
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(pattern)) {
    const openIndex = m.index + m[0].length - 1;
    const closeIndex = matchBalanced(text, openIndex, '(', ')');
    if (closeIndex !== -1) ranges.push([m.index, closeIndex + 1]);
  }
  let out = text;
  for (const [start, end] of ranges) {
    out = out.slice(0, start) + out.slice(start, end).replace(/[^\n]/g, ' ') + out.slice(end);
  }
  return out;
};

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * `t` is imported under other names — `ToastHost.svelte` takes it as `import { t as
 * translate } from './messages'` because the component already has a `$state` var called
 * `t` for a timestamp. A fixed `$t(` pattern would blank every ordinary call but not that
 * one, and a translation key would come back out looking like an offender. Read the actual
 * import instead of assuming the name.
 */
const translateAliasesIn = (source: string): string[] => {
  const aliases = ['t'];
  for (const m of source.matchAll(
    /import\s*\{[^}]*\bt\s+as\s+(\w+)[^}]*\}\s*from\s*['"][^'"]*(?:messages|i18n)['"]/g
  )) {
    aliases.push(m[1]);
  }
  return aliases;
};

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
    const offset = script.index + script[0].indexOf(body);
    for (const m of body.matchAll(SCRIPT_LITERALS)) {
      push(offset + m.index, m[2]);
    }
  }

  // The template: strip script, style and comments (keeping line numbers), then read.
  let template = blankRanges(
    source,
    /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g
  );

  // `aria-label={…}` / `title={…}`: a literal can hide *inside* the expression (a ternary
  // between two labels, `x || 'fallback'`), which `blankExpressions` below would otherwise
  // erase before anything reads it — that pass exists so a `{` in a ternary is never
  // mistaken for a tag boundary, and it does not distinguish "expression with a literal in
  // it" from "expression with none". `$t(...)` calls are blanked first so a catalog key
  // is never mistaken for prose.
  const translateCallPattern = new RegExp(
    `\\$(?:${translateAliasesIn(source).join('|')})\\s*\\(`,
    'g'
  );
  const withoutTCalls = blankCalls(template, translateCallPattern);
  for (const attr of BRACED_ATTRS) {
    for (const m of withoutTCalls.matchAll(new RegExp(`\\b${attr}=\\{`, 'g'))) {
      const openIndex = m.index + m[0].length - 1;
      const closeIndex = matchBalanced(withoutTCalls, openIndex, '{', '}');
      if (closeIndex === -1) continue;
      const expr = withoutTCalls.slice(openIndex + 1, closeIndex);
      for (const lit of expr.matchAll(QUOTED_LITERAL)) {
        // A literal next to a comparison operator (`tab === 'pending'`) is a state name
        // being matched, not a label being shown — `admin/tablet.svelte`'s `title={tab ===
        // 'pending' ? $t(...) : $t(...)}` is real code this scanner has to pass through
        // clean. Only a ternary branch, a `||`/`??` fallback, or the whole expression is an
        // actual label.
        const before = expr.slice(0, lit.index);
        const after = expr.slice(lit.index + lit[0].length);
        if (COMPARISON_BEFORE.test(before) || COMPARISON_AFTER.test(after)) continue;
        push(openIndex + 1 + lit.index, lit[2]);
      }
    }
  }

  template = blankExpressions(template);

  const attrs = READ_ATTRIBUTES.join('|');
  for (const m of template.matchAll(new RegExp(`\\b(?:${attrs})=(["'])([^"']*)\\1`, 'g'))) {
    push(m.index, m[2]);
  }
  // Text nodes: whatever sits between a `>` and the next `<`.
  for (const m of template.matchAll(/>([^<>]+)</g)) {
    push(m.index + 1, m[1]);
  }
  return found;
}

/**
 * The script half of the scan, over a plain `.ts` file (MICA-217).
 *
 * The Store's permission labels sat in a TypeScript table for the whole of MICA-214 and
 * -215 because this scanner only ever opened `.svelte` files, and a `label: 'Camera Access'`
 * in a `.ts` module is invisible to a rule about templates. Same keys, same regex, same
 * honesty about coverage: a string in any other position is still not seen.
 */
export function findHardcodedScriptStrings(source: string): HardcodedString[] {
  const found: HardcodedString[] = [];
  for (const m of source.matchAll(SCRIPT_LITERALS)) {
    const trimmed = m[2].replace(/\s+/g, ' ').trim();
    if (looksLikeProse(trimmed)) found.push({ line: lineOf(source, m.index), text: trimmed });
  }
  return found;
}
