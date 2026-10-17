// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * Glimpse's data layer (MICA-253). In-process facets, standing in for the shell, and one
 * `fetchNui` stub reached through the SDK's transport seam — the shape Blabber's test uses.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { Account, GlimpseComment, GlimpsePost } from '@mica/shared/types';
import * as fetchNuiModule from '../../nui/fetchNui';
import { registerNuiTransport } from '../../../../sdk/nui/transport';
import {
  LIKE,
  activeAccountId,
  addComment,
  createPost,
  editWindow,
  engagement,
  feed,
  likes,
  loadMyAccounts,
  myAccounts,
  removeComment,
  toggleLike
} from './store';

/** `{ service, action, data }` on the generic route; anything else is a named route. */
type SvcPayload = { service?: string; action?: string; data?: unknown } | undefined;

const callsTo = (spy: { mock: { calls: unknown[][] } }, service: string, action: string) =>
  spy.mock.calls
    .map((call): SvcPayload => call[1] as SvcPayload)
    .filter((payload) => payload?.service === service && payload?.action === action)
    .map((payload) => payload?.data);

const account = (id: number, handle: string): Account =>
  ({ id, app: 'glimpse', handle, display_name: null }) as Account;

const post: GlimpsePost = {
  id: 5,
  account_id: 20,
  caption: 'golden hour',
  created_at: '2026-10-16T10:00:00Z',
  updated_at: '2026-10-16T10:00:00Z',
  handle: 'ada',
  attachments: []
};

describe('glimpse store', () => {
  beforeEach(() => {
    registerNuiTransport((...args) => fetchNuiModule.fetchNui(...args));
    vi.restoreAllMocks();
    myAccounts.set([]);
    activeAccountId.set(null);
    engagement.set({});
    editWindow.set(900);
  });

  it('asks for the accounts in Glimpse, not in Blabber', async () => {
    const spy = vi
      .spyOn(fetchNuiModule, 'fetchNui')
      .mockResolvedValue({ rows: [account(20, 'ada')], limit: 3 });

    await loadMyAccounts();

    expect(callsTo(spy, 'accounts', 'mine')).toEqual([{ app: 'glimpse' }]);
    expect(get(activeAccountId)).toBe(20);
  });

  it('posts the chosen photos as the active account and keeps the edit window', async () => {
    myAccounts.set([account(20, 'ada')]);
    activeAccountId.set(20);
    feed.prepend = vi.fn();
    const spy = vi
      .spyOn(fetchNuiModule, 'fetchNui')
      .mockResolvedValue({ ...post, id: 101, editWindow: 600 });

    await createPost('  sunset  ', [{ photo_id: 7 }, { photo_id: 8 }]);

    expect(callsTo(spy, 'glimpse', 'create')).toEqual([
      { account_id: 20, caption: 'sunset', attachments: [{ photo_id: 7 }, { photo_id: 8 }] }
    ]);
    expect(get(editWindow)).toBe(600);
    expect(feed.prepend).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));
  });

  it('sends no caption at all for a photo-only post', async () => {
    myAccounts.set([account(20, 'ada')]);
    activeAccountId.set(20);
    feed.prepend = vi.fn();
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ ...post, id: 102 });

    await createPost('   ', [{ photo_id: 7 }]);

    expect(callsTo(spy, 'glimpse', 'create')).toEqual([
      { account_id: 20, caption: undefined, attachments: [{ photo_id: 7 }] }
    ]);
  });

  it('likes with ❤️ on mica_glimpse, as the active account', async () => {
    myAccounts.set([account(20, 'ada')]);
    activeAccountId.set(20);
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined);

    await toggleLike(5);

    expect(callsTo(spy, 'accounts', 'react')).toEqual([
      { app: 'glimpse', account_id: 20, target_table: 'mica_glimpse', target_id: 5, emoji: LIKE }
    ]);
    expect(get(likes)[5]).toEqual({ counts: { [LIKE]: 1 }, mine: [LIKE] });

    await toggleLike(5);

    expect(callsTo(spy, 'accounts', 'unreact')).toHaveLength(1);
    expect(get(likes)[5]).toEqual({ counts: {}, mine: [] });
  });

  it('refuses a like before painting it when no handle is claimed', async () => {
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(undefined);

    await expect(toggleLike(6)).rejects.toThrow('Claim a handle first.');

    expect(get(likes)[6]).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('comments as the active account and counts it', async () => {
    myAccounts.set([account(20, 'ada')]);
    activeAccountId.set(20);
    engagement.set({ 5: { comments: 2 } });
    const created: GlimpseComment = {
      id: 300,
      post_id: 5,
      account_id: 20,
      body: 'lovely',
      created_at: '',
      updated_at: ''
    };
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(created);

    await expect(addComment(5, ' lovely ')).resolves.toEqual(created);

    expect(callsTo(spy, 'glimpse_comments', 'create')).toEqual([
      { account_id: 20, post_id: 5, body: 'lovely' }
    ]);
    expect(get(engagement)[5]).toEqual({ comments: 3 });
  });

  it('removes a comment as the account it names — the post owner, for somebody else’s', async () => {
    engagement.set({ 5: { comments: 3 } });
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true);

    await removeComment(5, 300, 20);

    expect(callsTo(spy, 'glimpse_comments', 'remove')).toEqual([{ account_id: 20, id: 300 }]);
    expect(get(engagement)[5]).toEqual({ comments: 2 });
  });

  it('leaves the count alone when the server removed nothing', async () => {
    engagement.set({ 5: { comments: 3 } });
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(false);

    await expect(removeComment(5, 300, 20)).rejects.toThrow();

    expect(get(engagement)[5]).toEqual({ comments: 3 });
  });
});
