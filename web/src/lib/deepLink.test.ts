import { describe, it, expect } from 'vitest';
import { buildDeepLink, parseDeepLink } from '@shared/deepLink';

/**
 * The contract between what the server writes and what the phone opens.
 *
 * There was no parser at all before this, and three formats in the tree — so a link was
 * written correctly, stored correctly, and opened nothing. These assertions are mostly
 * about the ways a link can look fine and still fail to land.
 */
describe('deep links', () => {
  it('round-trips an app and its props', () => {
    expect(parseDeepLink(buildDeepLink('mail', { mailId: 12 }))).toEqual({
      app: 'mail',
      props: { mailId: 12 }
    });
  });

  it('omits the query when there are no props', () => {
    expect(buildDeepLink('settings')).toBe('settings');
    expect(parseDeepLink('settings')).toEqual({ app: 'settings', props: {} });
  });

  it('returns numbers for digit-only values', () => {
    // `useDeepLink` compares with `===`, so a string id never matches a row's numeric one.
    // The link would parse perfectly and open nothing.
    const parsed = parseDeepLink('mail?mailId=12');
    expect(parsed?.props.mailId).toBe(12);
    expect(parsed?.props.mailId).not.toBe('12');
  });

  it('keeps non-numeric values as strings', () => {
    expect(parseDeepLink('blabber?handle=nightowl')?.props.handle).toBe('nightowl');
    // A handle of digits stays a handle to the app, but arrives as a number — worth
    // pinning so the coercion rule is visible rather than surprising.
    expect(parseDeepLink('blabber?handle=123')?.props.handle).toBe(123);
  });

  it('tolerates the gphone:// prefix the mocks used to write', () => {
    expect(parseDeepLink('gphone://messages?conversationId=1')).toEqual({
      app: 'messages',
      props: { conversationId: 1 }
    });
  });

  it('round-trips values needing escapes', () => {
    const link = buildDeepLink('messages', { phone: '555 0100', q: 'a&b=c' });
    expect(parseDeepLink(link)?.props).toEqual({ phone: '555 0100', q: 'a&b=c' });
  });

  it('refuses anything that is not a link', () => {
    // The path-shaped strings the server used to write are the important case: `mail/12`
    // was handed whole to `openApp`, which registered a resident app by that name and
    // blanked the screen. Refusing is what turns that into a no-op.
    for (const bad of ['mail/12', 'blab/99', 'profile/nightowl', '', '   ', '?a=b', 'Mail!']) {
      expect(parseDeepLink(bad), bad).toBeNull();
    }
  });

  it('survives a malformed escape rather than throwing', () => {
    expect(() => parseDeepLink('mail?mailId=%E0%A4%A')).not.toThrow();
  });

  it('drops empty props when building', () => {
    expect(buildDeepLink('mail', { mailId: '', other: 3 })).toBe('mail?other=3');
  });
});
