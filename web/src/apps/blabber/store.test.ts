// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  feed,
  myAccounts,
  accountsLoaded,
  activeAccountId,
  activeAccount,
  accountLimit,
  canClaimAnother,
  editWindow,
  loadMyAccounts,
  updateAccount,
  claimAccount,
  postBlab,
  editBlab,
  deleteBlab,
  engagement,
  loadEngagement,
  toggleEar,
  followStats,
  loadFollowStats,
  toggleFollow,
  dmThreads,
  dmMessages,
  unreadDms,
  loadDmThreads,
  loadDmMessages,
  sendDm,
  dmReactions,
  loadDmReactions,
  toggleDmReaction,
  viewBlab,
  loadMoreReplies,
  accountResults,
  searchAccounts,
  blabResults,
  searchBlabs,
  tagResults,
  searchTags,
  trendingTags,
  loadTrendingTags,
  taggedBlabs,
  loadTaggedBlabs
} from './store';
import * as fetchNuiModule from '../../nui/fetchNui';
/**
 * MICA-172: one stub, reached two ways.
 *
 * This service calls `fetchNui` **directly** for some operations and through
 * `createCrudStore` — which goes via the SDK's transport seam — for others. Spying on only
 * one of those leaves the other talking to the real transport, which in a node environment
 * dies inside `isBrowser()` and reads as fixture trouble rather than as a stub that never
 * applied. Pointing the seam at this module's spied namespace makes the single
 * `vi.spyOn(fetchNuiModule, 'fetchNui')` below cover both routes.
 */
import { registerNuiTransport } from '../../../../sdk/nui/transport';
import type {
  Account,
  Blab,
  BlabEngagement,
  FollowStats,
  BlabberDmThread,
  BlabberDm
} from '@mica/shared/types';

/**
 * Which action a call is for, whichever route it took.
 *
 * Blabber's own service goes through the one generic NUI callback now, so the action name
 * arrives inside the payload as `{ service, action }` rather than as the first argument.
 * The `accounts` calls are still named routes, because `mica_accounts` is core.
 */
const actionOf = (name: unknown, payload: unknown): string => {
  if (name !== 'svc') return String(name);
  const p = payload as { service?: string; action?: string };
  return `${p?.service}:${p?.action}`;
};

describe('blabber service', () => {
  beforeEach(() => {
    registerNuiTransport((...args) => fetchNuiModule.fetchNui(...args));
    vi.restoreAllMocks();
    feed.load = vi.fn().mockImplementation(async () => {});
    myAccounts.set([]);
    accountsLoaded.set(false);
    activeAccountId.set(null);
    accountLimit.set(3);
    editWindow.set(900);
    engagement.set({});
    followStats.set({});
    dmThreads.set([]);
    dmMessages.set([]);
  });

  describe('accounts', () => {
    it('loadMyAccounts populates myAccounts, accountLimit, and sets activeAccountId', async () => {
      const mockAccounts: Account[] = [
        {
          id: 1,
          app: 'blabber',
          citizenid: 'CIT1',
          handle: 'alice',
          display_name: 'Alice',
          avatar: null,
          bio: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z'
        },
        {
          id: 2,
          app: 'blabber',
          citizenid: 'CIT1',
          handle: 'bob',
          display_name: 'Bob',
          avatar: null,
          bio: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z'
        }
      ];

      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
        rows: mockAccounts,
        limit: 5
      });

      await loadMyAccounts();

      expect(get(myAccounts)).toEqual(mockAccounts);
      expect(get(accountLimit)).toBe(5);
      expect(get(activeAccountId)).toBe(1);
      expect(get(activeAccount)).toEqual(mockAccounts[0]);
      expect(get(accountsLoaded)).toBe(true);
    });

    it('updateAccount sends patch and updates myAccounts store', async () => {
      myAccounts.set([
        {
          id: 1,
          app: 'blabber',
          citizenid: 'CIT1',
          handle: 'alice',
          display_name: 'Alice',
          avatar: null,
          bio: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z'
        }
      ]);
      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined);

      await updateAccount(1, { display_name: 'Alice Cooper', bio: 'Hello world' });

      expect(spy).toHaveBeenCalledWith(
        'updateAccount',
        {
          id: 1,
          display_name: 'Alice Cooper',
          bio: 'Hello world'
        },
        undefined
      );
      expect(get(myAccounts)[0].display_name).toBe('Alice Cooper');
      expect(get(myAccounts)[0].bio).toBe('Hello world');
    });

    it('claimAccount creates new account and sets activeAccountId', async () => {
      const created: Account = {
        id: 10,
        app: 'blabber',
        citizenid: 'CIT1',
        handle: 'charlie',
        display_name: 'Charlie',
        avatar: null,
        bio: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      };
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(created);

      const result = await claimAccount('charlie', 'Charlie');

      expect(result).toEqual(created);
      expect(get(myAccounts)).toContainEqual(created);
      expect(get(activeAccountId)).toBe(10);
    });

    it('canClaimAnother computes derived state correctly', () => {
      myAccounts.set([{ id: 1 } as Account, { id: 2 } as Account]);
      accountLimit.set(3);
      expect(get(canClaimAnother)).toBe(true);

      myAccounts.set([{ id: 1 } as Account, { id: 2 } as Account, { id: 3 } as Account]);
      expect(get(canClaimAnother)).toBe(false);
    });
  });

  describe('blabs (posts, edits, deletes)', () => {
    it('postBlab throws if no active account', async () => {
      activeAccountId.set(null);
      await expect(postBlab('Hello')).rejects.toThrow('Claim a handle before posting.');
    });

    it('postBlab creates and prepends a blab to feed', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1, handle: 'alice' } as Account]);

      const mockBlab: Blab = {
        id: 101,
        account_id: 1,
        body: 'Testing blab',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        reply_to: null,
        mouth_of: null
      };

      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
        ...mockBlab,
        editWindow: 600
      });

      const created = await postBlab('Testing blab');

      expect(created.id).toBe(101);
      expect(get(editWindow)).toBe(600);
      expect(get(feed)).toContainEqual(expect.objectContaining({ id: 101, body: 'Testing blab' }));
    });

    it('editBlab calls updateBlab NUI and updates feed store', async () => {
      const initialBlab: Blab = {
        id: 200,
        account_id: 1,
        body: 'Original text',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        reply_to: null,
        mouth_of: null
      };
      feed.prepend(initialBlab);

      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined);

      await editBlab(200, 'Updated text');

      expect(spy).toHaveBeenCalledWith(
        'svc',
        { service: 'blabber', action: 'update', data: { id: 200, body: 'Updated text' } },
        undefined
      );
      expect(get(feed).find((b) => b.id === 200)?.body).toBe('Updated text');
    });

    it('deleteBlab calls deleteBlab NUI and removes from feed store', async () => {
      feed.prepend({
        id: 1,
        account_id: 1,
        body: 'First',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        reply_to: null,
        mouth_of: null
      });
      feed.prepend({
        id: 2,
        account_id: 1,
        body: 'Second',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        reply_to: null,
        mouth_of: null
      });

      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined);

      await deleteBlab(1);

      expect(spy).toHaveBeenCalledWith(
        'svc',
        { service: 'blabber', action: 'delete', data: { id: 1 } },
        undefined
      );
      expect(get(feed).find((b) => b.id === 1)).toBeUndefined();
    });
  });

  describe('engagement & ears', () => {
    it('loadEngagement updates engagement map', async () => {
      const mockData: Record<number, BlabEngagement> = {
        101: { replies: 2, mouths: 1, ears: 5, earedByMe: true, mouthedByMe: false }
      };
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockData);

      await loadEngagement([101]);

      expect(get(engagement)[101]).toEqual(mockData[101]);
    });

    it('toggleEar optimistically ears a blab and calls earBlab', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1 } as Account]);
      engagement.set({
        101: { replies: 0, mouths: 0, ears: 0, earedByMe: false, mouthedByMe: false }
      });

      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined);

      await toggleEar(101);

      expect(get(engagement)[101].earedByMe).toBe(true);
      expect(get(engagement)[101].ears).toBe(1);
      expect(spy).toHaveBeenCalledWith(
        'svc',
        { service: 'blabber', action: 'ear', data: { blab_id: 101, account_id: 1 } },
        undefined
      );
    });

    it('toggleEar reverts optimistic update if NUI call fails', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1 } as Account]);
      engagement.set({
        101: { replies: 0, mouths: 0, ears: 0, earedByMe: false, mouthedByMe: false }
      });

      vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation((name, payload) => {
        const action = actionOf(name, payload);
        if (action === 'blabber:ear') return Promise.reject(new Error('Server error'));
        if (action === 'blabber:engagement')
          return Promise.resolve({
            101: { replies: 0, mouths: 0, ears: 0, earedByMe: false, mouthedByMe: false }
          } as any);
        return Promise.resolve(undefined as any);
      });

      await expect(toggleEar(101)).rejects.toThrow('Server error');
      expect(get(engagement)[101].earedByMe).toBe(false);
      expect(get(engagement)[101].ears).toBe(0);
    });
  });

  describe('follow stats & follows', () => {
    it('loadFollowStats updates followStats map', async () => {
      const stats: FollowStats = {
        followers: 10,
        following: 5,
        followedByMe: true,
        blockedByMe: false
      };
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(stats);

      await loadFollowStats(42);

      expect(get(followStats)[42]).toEqual(stats);
    });

    it('toggleFollow throws if trying to follow yourself', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1 } as Account]);

      await expect(toggleFollow(1)).rejects.toThrow('You cannot follow yourself.');
    });

    it('toggleFollow optimistically follows an account', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1 } as Account]);
      followStats.set({
        42: { followers: 10, following: 5, followedByMe: false, blockedByMe: false }
      });

      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined);

      await toggleFollow(42);

      expect(get(followStats)[42].followedByMe).toBe(true);
      expect(get(followStats)[42].followers).toBe(11);
      // The typed `call` rides the generic service action, so the transport sees one
      // envelope naming the contract's own action (MICA-213).
      expect(spy).toHaveBeenCalledWith('svc', {
        service: 'accounts',
        action: 'follow',
        data: {
          app: 'blabber',
          follower_account_id: 1,
          followee_account_id: 42
        }
      });
    });
  });

  describe('direct messages (DMs) & unread badges', () => {
    it('loadDmThreads updates dmThreads store and computes unreadDms', async () => {
      const threads: BlabberDmThread[] = [
        { peer_account_id: 2, handle: 'bob', display_name: 'Bob', unread: 3, last: null },
        { peer_account_id: 3, handle: 'charlie', display_name: 'Charlie', unread: 1, last: null }
      ];

      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(threads);

      await loadDmThreads();

      expect(get(dmThreads)).toEqual(threads);
      expect(get(unreadDms)).toBe(4);
    });

    it('loadDmMessages fetches messages, marks read, and reloads threads', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1 } as Account]);
      const mockDms: BlabberDm[] = [
        {
          id: 1,
          from_account: 2,
          to_account: 1,
          body: 'Hey',
          created_at: '2026-01-01',
          updated_at: '2026-01-01'
        }
      ];

      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation((name, payload) => {
        const action = actionOf(name, payload);
        if (action === 'blabber_dms:get') return Promise.resolve({ rows: mockDms } as any);
        if (action === 'blabber_dms:threads') return Promise.resolve([] as any);
        return Promise.resolve(undefined as any);
      });

      await loadDmMessages(2);

      expect(get(dmMessages)).toEqual(mockDms);
      expect(spy).toHaveBeenCalledWith(
        'svc',
        { service: 'blabber_dms', action: 'read', data: { account_id: 1, peer_account_id: 2 } },
        undefined
      );
    });

    /**
     * MICA-101. `blabber_dms:get` is keyset-paged on `id DESC`, so the wire order is
     * newest-first and the thread was rendering it straight through — a new message landed
     * above the older ones instead of below them.
     */
    it('loadDmMessages reverses the id DESC page into chronological order', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1 } as Account]);
      const dm = (id: number, body: string): BlabberDm => ({
        id,
        from_account: 2,
        to_account: 1,
        body,
        created_at: '2026-01-01',
        updated_at: '2026-01-01'
      });
      // As the server returns it: newest first.
      const wire = [dm(3, 'newest'), dm(2, 'middle'), dm(1, 'oldest')];

      vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation((name, payload) => {
        const action = actionOf(name, payload);
        if (action === 'blabber_dms:get') return Promise.resolve({ rows: wire } as any);
        if (action === 'blabber_dms:threads') return Promise.resolve([] as any);
        return Promise.resolve(undefined as any);
      });

      await loadDmMessages(2);

      expect(get(dmMessages).map((m) => m.id)).toEqual([1, 2, 3]);
      // The reply is not mutated in place — it is somebody else's array.
      expect(wire.map((m) => m.id)).toEqual([3, 2, 1]);
    });

    it('sendDm throws if no active account', async () => {
      activeAccountId.set(null);
      await expect(sendDm(2, 'Hello')).rejects.toThrow('Claim a handle first.');
    });

    it('sendDm posts DM and refreshes threads', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1 } as Account]);

      const mockDm: BlabberDm = {
        id: 50,
        from_account: 1,
        to_account: 2,
        body: 'Hello Bob',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      };

      vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation((name, payload) => {
        const action = actionOf(name, payload);
        if (action === 'blabber_dms:send') return Promise.resolve(mockDm as any);
        if (action === 'blabber_dms:threads') return Promise.resolve([] as any);
        return Promise.resolve(undefined as any);
      });

      await sendDm(2, 'Hello Bob');

      expect(get(dmMessages)).toContainEqual(mockDm);
    });

    /** MICA-101, the other half: a send appends, so the newest message is last. */
    it('sendDm appends the new message to the end of the thread', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1 } as Account]);

      const existing: BlabberDm = {
        id: 10,
        from_account: 2,
        to_account: 1,
        body: 'earlier',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      };
      dmMessages.set([existing]);

      const created: BlabberDm = {
        id: 11,
        from_account: 1,
        to_account: 2,
        body: 'later',
        created_at: '2026-01-01T00:01:00Z',
        updated_at: '2026-01-01T00:01:00Z'
      };

      vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation((name, payload) => {
        const action = actionOf(name, payload);
        if (action === 'blabber_dms:send') return Promise.resolve(created as any);
        if (action === 'blabber_dms:threads') return Promise.resolve([] as any);
        return Promise.resolve(undefined as any);
      });

      await sendDm(2, 'later');

      expect(get(dmMessages).map((m) => m.id)).toEqual([10, 11]);
    });

    /**
     * Reactions run on the shared primitive now (MICA-98), so the mechanics — the
     * optimistic paint, the rollback, the keyed map — are pinned in
     * `sdk/kit/createReactionStore.test.ts`. What is Blabber's and belongs here is the wiring:
     * which table, which identity, and the refusal that has to happen before the store paints
     * anything.
     */
    describe('DM reactions', () => {
      it('reads a page of DMs against the accounts service, by table', async () => {
        activeAccountId.set(1);
        myAccounts.set([{ id: 1 } as Account]);
        const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({});

        await loadDmReactions([10, 11]);

        expect(spy).toHaveBeenCalledWith(
          'svc',
          {
            service: 'accounts',
            action: 'reactionsFor',
            data: { app: 'blabber', target_table: 'mica_blabber_dms', target_ids: [10, 11] }
          },
          { defaultValue: {} }
        );
      });

      it('reacts as the active account, naming the DM row', async () => {
        activeAccountId.set(4);
        myAccounts.set([{ id: 4 } as Account]);
        const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined);

        await toggleDmReaction(10, '\u{1F525}');

        expect(spy).toHaveBeenCalledWith('svc', {
          service: 'accounts',
          action: 'react',
          data: {
            app: 'blabber',
            account_id: 4,
            target_table: 'mica_blabber_dms',
            target_id: 10,
            emoji: '\u{1F525}'
          }
        });
        expect(get(dmReactions)[10]).toEqual({ counts: { '\u{1F525}': 1 }, mine: ['\u{1F525}'] });
      });

      it('refuses before painting anything when no handle is claimed', async () => {
        activeAccountId.set(null);
        myAccounts.set([]);
        const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined);

        await expect(toggleDmReaction(12, '\u{1F44D}')).rejects.toThrow('Claim a handle first.');

        // The check is in front of the store, not inside the transport: a chip that fills and
        // then snaps back is worse than one that never moved.
        expect(get(dmReactions)[12]).toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
      });
    });
  });

  describe('viewing a Blab', () => {
    it('viewBlab calls the view action with the id', async () => {
      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
        root: { id: 7, account_id: 1, body: 'root', created_at: '', updated_at: '' },
        replies: [],
        nextCursor: null
      });

      const result = await viewBlab(7);

      // A third-argument `defaultValue` is what makes this degrade to an empty view rather
      // than throwing when the transport fails — `useService.call` forwards it wrapped as
      // `{ defaultValue }`, the same shape every other read in this file relies on.
      expect(spy).toHaveBeenCalledWith(
        'svc',
        { service: 'blabber', action: 'view', data: { id: 7 } },
        { defaultValue: { root: null, replies: [], nextCursor: null } }
      );
      expect(result.root?.id).toBe(7);
    });

    it('loadMoreReplies is a plain continuation call, with no anchor', async () => {
      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
        root: null,
        replies: [{ id: 12, account_id: 1, body: 'older', created_at: '', updated_at: '' }],
        nextCursor: 12
      });

      const result = await loadMoreReplies(7, 20);

      expect(spy).toHaveBeenCalledWith(
        'svc',
        { service: 'blabber', action: 'view', data: { id: 7, cursor: 20 } },
        { defaultValue: { root: null, replies: [], nextCursor: null } }
      );
      expect(result.rows).toHaveLength(1);
      expect(result.nextCursor).toBe(12);
    });

    it('viewBlab passes anchorId through when given', async () => {
      const spy = vi
        .spyOn(fetchNuiModule, 'fetchNui')
        .mockResolvedValue({ root: null, replies: [], nextCursor: null });

      await viewBlab(9, { anchorId: 9 });

      expect(spy).toHaveBeenCalledWith(
        'svc',
        { service: 'blabber', action: 'view', data: { id: 9, anchorId: 9 } },
        { defaultValue: { root: null, replies: [], nextCursor: null } }
      );
    });
  });

  describe('search', () => {
    it('searchAccounts loads the accountResults store scoped to blabber', async () => {
      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
        rows: [{ id: 1, app: 'blabber', handle: 'ada' }],
        nextCursor: null
      });

      await searchAccounts('ad');

      // The `accounts` facet, not a generic service call made from inside the frame.
      // `accounts` is not Blabber's own namespace, so `IframeHostServer`'s `serviceAllowed`
      // refuses one an add-on names for itself, and the segment answered "No people found"
      // for every query. The phone makes this call on the add-on's behalf, and since
      // MICA-213 it makes it as a typed `call` over the generic service action — one
      // envelope naming `accounts:search`. `app` is stated here; `cursor`/`limit` come from
      // `createPagedStore`'s own `fetchPage`. No `defaultValue`, so a failure throws and
      // `load`/`loadMore` decide whether to keep the existing page.
      expect(spy).toHaveBeenCalledWith('svc', {
        service: 'accounts',
        action: 'search',
        data: { app: 'blabber', q: 'ad', cursor: undefined, limit: undefined }
      });
      expect(get(accountResults)).toHaveLength(1);
    });

    it('searchBlabs loads the blabResults store', async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
        rows: [{ id: 8, account_id: 1, created_at: '', updated_at: '' }],
        nextCursor: null
      });

      await searchBlabs('traffic');

      expect(get(blabResults)).toHaveLength(1);
    });

    it('searchTags populates tagResults', async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
        rows: [{ tag: 'losangeles', uses: 5 }],
        nextCursor: null
      });

      await searchTags('los');

      expect(get(tagResults)).toEqual([{ tag: 'losangeles', uses: 5 }]);
    });

    it('loadTrendingTags populates trendingTags', async () => {
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue([{ tag: 'losangeles', uses: 40 }]);

      await loadTrendingTags();

      expect(get(trendingTags)).toEqual([{ tag: 'losangeles', uses: 40 }]);
    });

    it('loadTaggedBlabs loads the taggedBlabs store for one tag', async () => {
      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
        rows: [{ id: 8, account_id: 1, created_at: '', updated_at: '' }],
        nextCursor: null
      });

      await loadTaggedBlabs('losangeles');

      expect(spy).toHaveBeenCalledWith('svc', {
        service: 'blabber',
        action: 'by_tag',
        data: { tag: 'losangeles', cursor: undefined, limit: undefined }
      });
      expect(get(taggedBlabs)).toHaveLength(1);
    });
  });
});
