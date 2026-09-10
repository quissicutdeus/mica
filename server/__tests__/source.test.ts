// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return { handlers: captured };
});
vi.mock('../lib/Database', () => ({ Database: { query: vi.fn(), single: vi.fn() } }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: 'CIT_A', source: 5, setMeta: () => {} })
  }
}));

import { serverLocale, sourceUrl } from '../services/Source';
import { __resetRateLimits } from '../lib/rateLimit';

const UPSTREAM = 'https://github.com/quissicutdeus/mica';

/** Answer `mica_source_url` with `value`, or fall through to the default. */
const withConvar = (value: string | null) => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_source_url' && value !== null ? value : fallback;
};

/**
 * The AGPL §13 source address (MICA-192).
 *
 * §13's obligation belongs to the operator: a player on a server running a modified copy is
 * a remote user entitled to *that server's* source. So the answer comes from a convar rather
 * than a constant compiled into the phone — a fork whose phone points at this repository is
 * telling its players something false while looking compliant.
 */
describe('the source address a server reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimits();
    withConvar(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers upstream when the operator has set nothing', () => {
    // True for a server running an unmodified copy, which is most of them.
    expect(sourceUrl()).toBe(UPSTREAM);
  });

  it("answers the operator's own repository when they set one", () => {
    withConvar('https://git.example.com/rp/mica-fork');
    expect(sourceUrl()).toBe('https://git.example.com/rp/mica-fork');
  });

  /**
   * A typo falls back rather than throwing or displaying itself. The phone never navigates
   * to this — §6 forbids it, and the pane copies the string — so this is not blocking a
   * `javascript:` URL from being followed. It is refusing to present something that is not
   * an address as though it were one, because a §13 offer a player cannot act on is not an
   * offer, and an operator's mistake should not take the licence notice off the screen.
   */
  it.each([
    ['not-a-url', 'bare text'],
    ['http://example.com/src', 'plain http'],
    ['javascript:alert(1)', 'a script URL'],
    ['https://', 'a scheme with no host'],
    ['   ', 'whitespace']
  ])('falls back to upstream for %s (%s)', (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withConvar(value);

    expect(sourceUrl()).toBe(UPSTREAM);
    // Loud, because silently substituting upstream is how an operator stays out of
    // compliance without ever being told.
    expect(warn).toHaveBeenCalled();
  });

  it('trims surrounding whitespace rather than rejecting the value for it', () => {
    withConvar('  https://git.example.com/rp/mica-fork  ');
    expect(sourceUrl()).toBe('https://git.example.com/rp/mica-fork');
  });

  it('answers over NUI without reading anything from the payload', async () => {
    withConvar('https://git.example.com/rp/mica-fork');
    const handler = handlers.get('mica:server:shell:sourceUrl');
    expect(handler).toBeDefined();

    (globalThis as any).source = 5;
    (globalThis as any).emitNet = vi.fn();
    await handler!('cb-1', undefined);

    expect((globalThis.emitNet as any).mock.calls[0]?.[3]).toEqual({
      url: 'https://git.example.com/rp/mica-fork'
    });

    // A steered payload changes nothing because it never arrives: the answer is a property
    // of the server, so the contract declares no payload at all and one sent anyway is
    // refused rather than ignored.
    (globalThis as any).emitNet = vi.fn();
    await handler!('cb-2', { url: 'https://evil.example/', citizenid: 'CIT_B' });

    expect((globalThis.emitNet as any).mock.calls[0]?.[3]).toMatchObject({
      error: expect.any(String)
    });
  });
});

/**
 * The owner's default language (MICA-61), the same shape as the source address above: a
 * convar, validated, answered over NUI with nothing read from the payload.
 */
describe('the default locale a server reports', () => {
  const withLocale = (value: string | null) => {
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_locale' && value !== null ? value : fallback;
  };

  beforeEach(() => {
    __resetRateLimits();
    withLocale(null);
  });

  it("answers '' when the operator has set nothing, so the player's own language decides", () => {
    expect(serverLocale()).toBe('');
  });

  it('answers a language tag, with or without a region', () => {
    withLocale('de');
    expect(serverLocale()).toBe('de');
    withLocale(' pt-BR ');
    expect(serverLocale()).toBe('pt-BR');
  });

  it('ignores a value that is not a tag, and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withLocale('German please');
    expect(serverLocale()).toBe('');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mica_locale'));
  });

  it('answers over NUI without reading anything from the payload', async () => {
    withLocale('fr');
    const handler = handlers.get('mica:server:shell:locale');
    expect(handler).toBeDefined();
    (globalThis as any).source = 5;
    (globalThis as any).emitNet = vi.fn();
    await handler!('cb-1', undefined);
    expect((globalThis.emitNet as any).mock.calls.at(-1)?.[3]).toEqual({ locale: 'fr' });
  });
});

/**
 * What the owner switched off and what the dock holds (MICA-234), answered over the same
 * endpoint and the same way: from convars, with nothing read from the payload.
 */
describe('the owner config a server reports', () => {
  beforeEach(() => {
    __resetRateLimits();
  });

  it('answers the parsed disabled list and dock over NUI', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      ({ mica_disabled_apps: 'hodlr,settings', mica_default_dock: 'phone,,camera' })[name] ??
      fallback;
    const handler = handlers.get('mica:server:shell:ownerConfig');
    expect(handler).toBeDefined();

    (globalThis as any).source = 5;
    (globalThis as any).emitNet = vi.fn();
    await handler!('cb-1', undefined);

    expect((globalThis.emitNet as any).mock.calls.at(-1)?.[3]).toEqual({
      disabledApps: ['hodlr'],
      defaultDock: ['phone', '', 'camera', '']
    });
  });

  it('answers nothing disabled and the built-in dock when the owner set neither', async () => {
    (globalThis as any).GetConvar = (_name: string, fallback: string) => fallback;
    (globalThis as any).source = 5;
    (globalThis as any).emitNet = vi.fn();
    await handlers.get('mica:server:shell:ownerConfig')!('cb-1', undefined);

    expect((globalThis.emitNet as any).mock.calls.at(-1)?.[3]).toEqual({
      disabledApps: [],
      defaultDock: []
    });
  });
});
