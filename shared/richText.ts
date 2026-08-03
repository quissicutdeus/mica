/**
 * Splitting a message into the pieces a UI wants to style differently.
 *
 * Shared by every app that renders player-written text, so `@ada` means the same thing in a
 * Blab, a DM and an Instagram caption — and so there is one place to audit rather than one per
 * app.
 *
 * **It returns data, not markup, and that is the security property.** The alternative is
 * building an HTML string and handing it to `{@html}`, which is how a message becomes script.
 * Every token here is rendered through Svelte's `{text}`, which escapes — so there is nothing
 * to sanitize, because nothing is ever parsed as HTML. The one `{@html}` in this codebase is
 * Notes' markdown, and it earns it by going through `marked` + DOMPurify with an allowlist;
 * matching that here would mean taking on the same risk to gain nothing.
 *
 * Deliberately not markdown. A 280-character post does not want tables and blockquotes, and
 * every construct accepted is a construct that has to be rendered safely.
 */

export type RichTextToken =
  | { kind: 'text'; value: string }
  /** `@handle` — `value` excludes the sigil, so a caller can look it up directly. */
  | { kind: 'mention'; value: string }
  /** `#tag` — same. */
  | { kind: 'tag'; value: string };

/**
 * Handle and tag shapes, matching what `gphone_accounts.handle` accepts: lowercase letters,
 * numbers and underscore, 3–32 characters.
 *
 * Case-insensitive on the way in because people type `@Ada`, and normalised on the way out —
 * the account table lowercases handles at claim time, so a mention that kept its capitals
 * would resolve to nobody.
 *
 * The trailing `(?![\w])` matters: without it `@ada_lovelace` would match the 3-character
 * prefix `@ada` and leave `_lovelace` as text, silently notifying the wrong person.
 */
const PATTERN = /([@#])([A-Za-z0-9_]{3,32})(?![A-Za-z0-9_])/g;

/**
 * Tokenize a message.
 *
 * Never throws and never drops input: concatenating every token's source is the original
 * string. A parser that can lose characters is a parser that can lose the end of somebody's
 * sentence.
 */
export function tokenizeRichText(input: string): RichTextToken[] {
  if (!input) return [];

  const tokens: RichTextToken[] = [];
  let cursor = 0;

  for (const match of input.matchAll(PATTERN)) {
    const at = match.index ?? 0;

    /**
     * Only treat a sigil as a sigil at a word boundary.
     *
     * Otherwise an email address becomes a mention of its domain, and `a#1` becomes a tag.
     * Checked here rather than in the pattern because a lookbehind is not safe to rely on
     * across the CEF baseline (§6) — Chromium 103 has it, but the postcss story is a reminder
     * that "the browser supports it" and "the shipped runtime supports it" differ.
     */
    const before = at > 0 ? input[at - 1] : '';
    if (before && /[A-Za-z0-9_]/.test(before)) continue;

    if (at > cursor) tokens.push({ kind: 'text', value: input.slice(cursor, at) });

    tokens.push({
      kind: match[1] === '@' ? 'mention' : 'tag',
      value: match[2].toLowerCase()
    });
    cursor = at + match[0].length;
  }

  if (cursor < input.length) tokens.push({ kind: 'text', value: input.slice(cursor) });
  return tokens;
}

/**
 * Every handle mentioned in a message, lowercased and deduplicated.
 *
 * What the server notifies from. Derived from the same tokenizer the UI renders with, so what
 * a player sees highlighted and who actually gets told cannot disagree — two regexes for one
 * question is how you get a mention that lights up and never notifies.
 */
export function mentionedHandles(input: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenizeRichText(input)) {
    if (token.kind === 'mention') seen.add(token.value);
  }
  return [...seen];
}
