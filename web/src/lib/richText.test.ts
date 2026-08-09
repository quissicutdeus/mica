import { describe, it, expect } from 'vitest';
import { mentionedHandles, taggedTopics, tokenizeRichText } from '@shared/richText';

/**
 * The tokenizer every app that renders player text shares.
 *
 * It lives in `shared/` rather than `web/src/lib/` because both sides need it: the web renders
 * mentions with it, and the **server** derives who to notify from it. Two implementations of
 * "what counts as a mention" is how you get one that highlights and never notifies.
 *
 * The test stays here because nothing globs `shared/` — the web Vitest project covers
 * `web/src/**`, the server project covers `server/__tests__/`.
 *
 * It returns data rather than markup, which is the whole security argument: each token is
 * rendered through Svelte's `{text}` and escapes, so there is nothing to sanitize because
 * nothing is parsed as HTML. These tests hold that line, and hold the boundary rules — a
 * mention that matches the wrong substring notifies the wrong player.
 */

describe('tokenizeRichText', () => {
  it('returns plain text as a single token', () => {
    expect(tokenizeRichText('hello world')).toEqual([{ kind: 'text', value: 'hello world' }]);
  });

  it('splits a mention out of surrounding text', () => {
    expect(tokenizeRichText('hey @ada look')).toEqual([
      { kind: 'text', value: 'hey ' },
      { kind: 'mention', value: 'ada' },
      { kind: 'text', value: ' look' }
    ]);
  });

  it('lowercases a mention, because handles are stored lowercase', () => {
    // A mention that kept its capitals would resolve to nobody: the accounts table lowercases
    // at claim time.
    expect(tokenizeRichText('@AdA')).toEqual([{ kind: 'mention', value: 'ada' }]);
  });

  it('takes the whole handle, not a matching prefix', () => {
    // The bug this guards: `@ada_lovelace` matching the 3-character `@ada` would highlight
    // and notify an entirely different person, and the rest would render as stray text.
    expect(tokenizeRichText('@ada_lovelace')).toEqual([{ kind: 'mention', value: 'ada_lovelace' }]);
  });

  it('does not read a sigil mid-word as a sigil', () => {
    // Otherwise an email becomes a mention of its domain.
    expect(tokenizeRichText('mail me at ada@example')).toEqual([
      { kind: 'text', value: 'mail me at ada@example' }
    ]);
  });

  it('handles tags and mentions together', () => {
    expect(tokenizeRichText('@ada #losangeles')).toEqual([
      { kind: 'mention', value: 'ada' },
      { kind: 'text', value: ' ' },
      { kind: 'tag', value: 'losangeles' }
    ]);
  });

  it('ignores a handle shorter than the minimum', () => {
    // Matching the accounts table: nothing under 3 characters can be claimed, so nothing
    // under 3 characters can be mentioned.
    expect(tokenizeRichText('@ab')).toEqual([{ kind: 'text', value: '@ab' }]);
  });

  it('never loses input — the tokens reassemble the original', () => {
    // A parser that can drop characters is a parser that can drop the end of a sentence.
    const inputs = [
      'plain',
      '@ada hi',
      'hi @ada',
      '@ada@bob',
      '#a #ab #abc',
      'e@mail.com and @ada',
      '@@ada',
      '   ',
      '@ada!',
      'trailing @'
    ];
    for (const input of inputs) {
      const rebuilt = tokenizeRichText(input)
        .map((t) => (t.kind === 'text' ? t.value : `${t.kind === 'mention' ? '@' : '#'}${t.value}`))
        .join('');
      expect(rebuilt.toLowerCase()).toBe(input.toLowerCase());
    }
  });

  it('returns nothing for an empty string', () => {
    expect(tokenizeRichText('')).toEqual([]);
  });

  it('treats markup as text, because it is never parsed as HTML', () => {
    // The property that makes a sanitizer unnecessary: the angle brackets come back as a text
    // token and reach the DOM through `{text}`, which escapes.
    const tokens = tokenizeRichText('<script>alert(1)</script> @ada');

    expect(tokens[0]).toEqual({ kind: 'text', value: '<script>alert(1)</script> ' });
    expect(tokens[1]).toEqual({ kind: 'mention', value: 'ada' });
  });
});

describe('mentionedHandles', () => {
  it('collects every mention once', () => {
    expect(mentionedHandles('@ada @bob @ada')).toEqual(['ada', 'bob']);
  });

  it('shares the tokenizer with the renderer', () => {
    // Two regexes for one question is how you get a mention that highlights and never
    // notifies. Same input, same answer, by construction.
    const body = 'cc @ada and not ada@example #tag';

    expect(mentionedHandles(body)).toEqual(['ada']);
  });

  it('returns nothing when there is nothing to notify', () => {
    expect(mentionedHandles('just talking')).toEqual([]);
    expect(mentionedHandles('')).toEqual([]);
  });
});

describe('taggedTopics', () => {
  it('extracts hashtags, lowercased and deduplicated', () => {
    expect(taggedTopics('Loving #LosAngeles today, #losangeles never disappoints')).toEqual([
      'losangeles'
    ]);
  });

  it('ignores mentions and plain text', () => {
    expect(taggedTopics('@ada said hi, no tags here')).toEqual([]);
  });

  it('returns tags in first-appearance order', () => {
    expect(taggedTopics('#one #two #three')).toEqual(['one', 'two', 'three']);
  });

  it('returns an empty array for empty input', () => {
    expect(taggedTopics('')).toEqual([]);
  });

  it('agrees with tokenizeRichText about what counts as a tag', () => {
    const body = 'traffic on the interstate #losangeles is unreal #traffic';
    const fromTokens = tokenizeRichText(body)
      .filter((t) => t.kind === 'tag')
      .map((t) => t.value);
    expect(taggedTopics(body)).toEqual([...new Set(fromTokens)]);
  });
});
