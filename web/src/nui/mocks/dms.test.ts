// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-390: the `dms` mock keeps the server's rules — an app with no DM policy is refused, a
 * thread is read only as an account the player owns in that app, and a peer in another app is
 * "no such account". Without them `pnpm dev` and the e2e suite pass on DMs the game refuses.
 * Fresh modules per case, since the message table is module scope.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockHandler } from './registry';

let dms: Record<string, MockHandler>;

beforeEach(async () => {
  vi.resetModules();
  dms = (await import('./services/dms')).mocks;
});

describe('dms mocks', () => {
  it("serves Blabber's inbox, scoped to the player's Blabber accounts", async () => {
    const threads = (await dms['dms:threads']({ app: 'blabber' })) as {
      peer_account_id: number;
      unread: number;
    }[];
    expect(threads.map((t) => t.peer_account_id)).toEqual([2]);
    expect(threads[0].unread).toBe(1);
  });

  it('refuses an app that registered no policy, on every action', async () => {
    // Glimpse has accounts on the identity layer and no DMs.
    expect(() => dms['dms:threads']({ app: 'glimpse' })).toThrow(/direct messages/);
    expect(() => dms['dms:get']({ app: 'glimpse', account_id: 20, peer_account_id: 21 })).toThrow(
      /direct messages/
    );
    expect(() =>
      dms['dms:send']({ app: 'glimpse', account_id: 20, peer_account_id: 21, body: 'hi' })
    ).toThrow(/direct messages/);
    expect(() => dms['dms:read']({ app: 'glimpse', account_id: 20, peer_account_id: 21 })).toThrow(
      /direct messages/
    );
  });

  it('refuses a peer in another app, and an account that is not in the app named', async () => {
    // 21 is a Glimpse account; Blabber cannot reach it.
    expect(() =>
      dms['dms:send']({ app: 'blabber', account_id: 1, peer_account_id: 21, body: 'hi' })
    ).toThrow("You can't message this account.");
    // 20 is the player's, but in Glimpse: naming Blabber does not make it a Blabber account.
    expect(() =>
      dms['dms:send']({ app: 'blabber', account_id: 20, peer_account_id: 2, body: 'hi' })
    ).toThrow('That account is not yours.');
    expect(() => dms['dms:get']({ app: 'blabber', account_id: 2, peer_account_id: 1 })).toThrow(
      'That account is not yours.'
    );
  });

  it('reads a thread as the account named, and a send lands in it', async () => {
    const sent = (await dms['dms:send']({
      app: 'blabber',
      account_id: 1,
      peer_account_id: 2,
      body: '  hey  '
    })) as { from_account: number; body: string };
    expect(sent).toMatchObject({ from_account: 1, body: 'hey' });

    const page = (await dms['dms:get']({ app: 'blabber', account_id: 1, peer_account_id: 2 })) as {
      rows: { id: number }[];
    };
    expect(page.rows.map((r) => r.id)).toEqual([50, 1]);
    // The player's other Blabber account has no thread with 2.
    const alt = (await dms['dms:get']({ app: 'blabber', account_id: 4, peer_account_id: 2 })) as {
      rows: unknown[];
    };
    expect(alt.rows).toEqual([]);
  });
});
