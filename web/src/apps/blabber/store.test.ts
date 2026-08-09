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
  toggleLike,
  followStats,
  loadFollowStats,
  toggleFollow,
  unreadMentions,
  clearUnreadMentions,
  dmThreads,
  dmMessages,
  unreadDms,
  loadDmThreads,
  loadDmMessages,
  sendDm
} from './store';
import * as fetchNuiModule from '../../nui/fetchNui';
import type {
  Account,
  Blab,
  BlabEngagement,
  FollowStats,
  BlabberDmThread,
  BlabberDm
} from '@shared/types';

/**
 * Which action a call is for, whichever route it took.
 *
 * Blabber's own service goes through the one generic NUI callback now, so the action name
 * arrives inside the payload as `{ service, action }` rather than as the first argument.
 * The `accounts` calls are still named routes, because `gphone_accounts` is core.
 */
const actionOf = (name: unknown, payload: unknown): string => {
  if (name !== 'svc') return String(name);
  const p = payload as { service?: string; action?: string };
  return `${p?.service}:${p?.action}`;
};

describe('blabber service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    feed.load = vi.fn().mockImplementation(async () => {});
    myAccounts.set([]);
    accountsLoaded.set(false);
    activeAccountId.set(null);
    accountLimit.set(3);
    editWindow.set(900);
    engagement.set({});
    followStats.set({});
    clearUnreadMentions();
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
      } as any);

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
      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined as any);

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
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(created as any);

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
      } as any);

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

      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined as any);

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

      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined as any);

      await deleteBlab(1);

      expect(spy).toHaveBeenCalledWith(
        'svc',
        { service: 'blabber', action: 'delete', data: { id: 1 } },
        undefined
      );
      expect(get(feed).find((b) => b.id === 1)).toBeUndefined();
    });
  });

  describe('engagement & likes', () => {
    it('loadEngagement updates engagement map', async () => {
      const mockData: Record<number, BlabEngagement> = {
        101: { replies: 2, mouths: 1, likes: 5, likedByMe: true, mouthedByMe: false }
      };
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mockData as any);

      await loadEngagement([101]);

      expect(get(engagement)[101]).toEqual(mockData[101]);
    });

    it('toggleLike optimistically likes a blab and calls likeBlab', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1 } as Account]);
      engagement.set({
        101: { replies: 0, mouths: 0, likes: 0, likedByMe: false, mouthedByMe: false }
      });

      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined as any);

      await toggleLike(101);

      expect(get(engagement)[101].likedByMe).toBe(true);
      expect(get(engagement)[101].likes).toBe(1);
      expect(spy).toHaveBeenCalledWith(
        'svc',
        { service: 'blabber', action: 'like', data: { blab_id: 101, account_id: 1 } },
        undefined
      );
    });

    it('toggleLike reverts optimistic update if NUI call fails', async () => {
      activeAccountId.set(1);
      myAccounts.set([{ id: 1 } as Account]);
      engagement.set({
        101: { replies: 0, mouths: 0, likes: 0, likedByMe: false, mouthedByMe: false }
      });

      vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation((name, payload) => {
        const action = actionOf(name, payload);
        if (action === 'blabber:like') return Promise.reject(new Error('Server error'));
        if (action === 'blabber:engagement')
          return Promise.resolve({
            101: { replies: 0, mouths: 0, likes: 0, likedByMe: false, mouthedByMe: false }
          } as any);
        return Promise.resolve(undefined as any);
      });

      await expect(toggleLike(101)).rejects.toThrow('Server error');
      expect(get(engagement)[101].likedByMe).toBe(false);
      expect(get(engagement)[101].likes).toBe(0);
    });
  });

  describe('follow stats & follows', () => {
    it('loadFollowStats updates followStats map', async () => {
      const stats: FollowStats = { followers: 10, following: 5, followedByMe: true };
      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(stats as any);

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
        42: { followers: 10, following: 5, followedByMe: false }
      });

      const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined as any);

      await toggleFollow(42);

      expect(get(followStats)[42].followedByMe).toBe(true);
      expect(get(followStats)[42].followers).toBe(11);
      expect(spy).toHaveBeenCalledWith(
        'followAccount',
        {
          app: 'blabber',
          follower_account_id: 1,
          followee_account_id: 42
        },
        undefined
      );
    });
  });

  describe('direct messages (DMs) & unread badges', () => {
    it('loadDmThreads updates dmThreads store and computes unreadDms', async () => {
      const threads: BlabberDmThread[] = [
        { peer_account_id: 2, handle: 'bob', display_name: 'Bob', unread: 3, last: null },
        { peer_account_id: 3, handle: 'charlie', display_name: 'Charlie', unread: 1, last: null }
      ];

      vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(threads as any);

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

    it('unreadMentions can be cleared', () => {
      unreadMentions.set(5);
      clearUnreadMentions();
      expect(get(unreadMentions)).toBe(0);
    });
  });
});
