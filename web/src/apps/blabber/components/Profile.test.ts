// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../../host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';
import * as fetchNuiModule from '../../../nui/fetchNui';
import { registerNuiTransport } from '../../../../../sdk/nui/transport';

import Profile from './Profile.svelte';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('blabber', { en, de });

const ACCOUNT = { id: 7, app: 'blabber', handle: 'ada', display_name: 'Ada' };
const STATS = { followers: 1, following: 2, followedByMe: false, blockedByMe: false };

/**
 * A refused request, answered the way the real `fetchNui` answers one: the default when the
 * caller asked for one, a throw when it did not. `mockRejectedValue` would skip the
 * defaulting and pass against the page read this pins (MICA-384).
 */
const refuse = (_event: string, _data?: unknown, options?: { defaultValue?: unknown }) =>
  options?.defaultValue !== undefined
    ? Promise.resolve(options.defaultValue)
    : Promise.reject(new Error('Player not authenticated'));

/** The server behind the profile, with `profile` answered by `page`. */
const serve = (page: typeof refuse) =>
  vi
    .spyOn(fetchNuiModule, 'fetchNui')
    .mockImplementation((name: string, payload?: unknown, options?: { defaultValue?: unknown }) => {
      const p = payload as { service?: string; action?: string } | undefined;
      const action = name === 'svc' ? `${p?.service}:${p?.action}` : name;
      if (action === 'getAccounts') return Promise.resolve({ rows: [ACCOUNT] });
      if (action === 'accounts:follows') return Promise.resolve(STATS);
      if (action === 'blabber:profile') return page(name, payload, options);
      return Promise.resolve(null);
    });

const profileAsked = (spy: ReturnType<typeof serve>) =>
  spy.mock.calls.some(
    ([name, payload]) =>
      name === 'svc' && (payload as { action?: string } | undefined)?.action === 'profile'
  );

/**
 * MICA-384: the first page of a profile's Blabs defaulted to `{ rows: [] }`, which is what a
 * profile with no Blabs looks like — so a failed read said "No Blabs yet" about an account
 * that has posted.
 */
describe('Profile, when its Blabs fail to load', () => {
  beforeEach(() => {
    registerNuiTransport((...args) => fetchNuiModule.fetchNui(...args));
  });
  afterEach(() => vi.restoreAllMocks());

  it('says "No Blabs yet" for a real empty page — the control', async () => {
    const spy = serve(() => Promise.resolve({ rows: [], nextCursor: null }));
    const view = render(Profile, { props: { handle: 'ada' } });

    await waitFor(() => expect(view.queryByText(en.noBlabsYet)).not.toBeNull());
    expect(profileAsked(spy)).toBe(true);
  });

  it('does not say "No Blabs yet" when the page read failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = serve(refuse);
    const view = render(Profile, { props: { handle: 'ada' } });

    await waitFor(() => expect(profileAsked(spy)).toBe(true));
    // Let the refusal settle and the component re-render before looking.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(view.queryByText(en.noBlabsYet)).toBeNull();
    expect(view.queryByText(en.noHandle)).toBeNull();
  });
});
