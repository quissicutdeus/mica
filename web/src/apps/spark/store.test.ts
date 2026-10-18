// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * Spark's data layer (MICA-255). In-process facets, standing in for the shell, and one
 * `fetchNui` stub reached through the SDK's transport seam, answering per service and action —
 * the shape Dark Chat's test uses.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type {
  DirectMessage,
  DirectMessageThread,
  SparkCard,
  SparkMatch,
  SparkProfile
} from '@mica/shared/types';
import * as fetchNuiModule from '../../nui/fetchNui';
import { registerNuiTransport } from '../../../../sdk/nui/transport';
import {
  deck,
  inbox,
  loadDeck,
  matches,
  profile,
  receiveUnmatched,
  removeProfile,
  swipe,
  threads
} from './store';

type SvcPayload = { service?: string; action?: string; data?: unknown } | undefined;
type Answer = (data: unknown) => unknown;

const ME = 30;
const MAYA = 31;

const card = (id: number, account_id: number, display_name = `p${id}`): SparkCard => ({
  id,
  account_id,
  display_name,
  age: 25,
  bio: null,
  looking_for: null,
  photos: []
});

const mine: SparkProfile = {
  ...card(100, ME, 'Ada'),
  status: 'active',
  photo_ids: [1]
};

const match = (id: number, profileCard: SparkCard, created_at = '2026-10-17T10:00:00Z') => ({
  id,
  profile: profileCard,
  created_at
});

const dm = (id: number, from: number, to: number, created_at = '2026-10-17T11:00:00Z') =>
  ({
    id,
    from_account: from,
    to_account: to,
    body: `line ${id}`,
    read_at: null,
    status: 'active',
    created_at,
    updated_at: created_at
  }) as DirectMessage;

/** Route every request by `<service>:<action>`; anything unrouted fails the test loudly. */
const serve = (answers: Record<string, Answer>) =>
  vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(async (_name, payload) => {
    const p = payload as SvcPayload;
    const key = `${p?.service}:${p?.action}`;
    const answer = answers[key];
    if (!answer) throw new Error(`unrouted ${key}`);
    return answer(p?.data);
  });

const callsTo = (spy: { mock: { calls: unknown[][] } }, key: string) =>
  spy.mock.calls
    .map((call): SvcPayload => call[1] as SvcPayload)
    .filter((p) => `${p?.service}:${p?.action}` === key)
    .map((p) => p?.data);

describe('spark store', () => {
  beforeEach(() => {
    registerNuiTransport((...args) => fetchNuiModule.fetchNui(...args));
    vi.restoreAllMocks();
    profile.set(mine);
    matches.set([]);
    threads.set([]);
  });

  it('takes a swiped card out of the deck, and a first like adds no match', async () => {
    serve({
      'spark:deck': () => ({ rows: [card(3, MAYA), card(2, 32)], nextCursor: null }),
      'spark:swipe': () => ({ match: null })
    });
    await loadDeck();
    expect(get(deck).map((c) => c.id)).toEqual([3, 2]);

    expect(await swipe(card(3, MAYA), 'like')).toBeNull();
    expect(get(deck).map((c) => c.id)).toEqual([2]);
    expect(get(matches)).toEqual([]);
  });

  it('puts a mutual like straight into the matches', async () => {
    const made = match(1, card(3, MAYA, 'Maya'));
    const spy = serve({
      'spark:swipe': () => ({ match: made }),
      'dms:threads': () => []
    });
    expect(await swipe(card(3, MAYA), 'like')).toEqual(made);
    expect(callsTo(spy, 'spark:swipe')).toEqual([{ profile_id: 3, verdict: 'like' }]);
    expect(get(matches)).toEqual([made]);
  });

  it('merges threads into the matches by account, most recent activity first', () => {
    const quiet = match(1, card(2, 32), '2026-10-17T09:00:00Z');
    const chatty = match(2, card(3, MAYA), '2026-10-16T09:00:00Z');
    matches.set([quiet, chatty]);
    const thread: DirectMessageThread = {
      peer_account_id: MAYA,
      handle: 'spark_31',
      display_name: 'Maya',
      last: dm(5, MAYA, ME, '2026-10-17T12:00:00Z'),
      unread: 2
    };
    threads.set([thread]);
    expect(get(inbox).map((row) => [row.match.id, row.unread, row.last?.id ?? null])).toEqual([
      [2, 2, 5],
      [1, 0, null]
    ]);
  });

  it('drops an unmatched match', () => {
    matches.set([match(1, card(3, MAYA)), match(2, card(2, 32))]);
    receiveUnmatched(1);
    expect(get(matches).map((m) => m.id)).toEqual([2]);
  });

  it('forgets the profile, matches and threads on delete', async () => {
    matches.set([match(1, card(3, MAYA))] as SparkMatch[]);
    serve({ 'spark:remove': () => true });
    await removeProfile();
    expect(get(profile)).toBeNull();
    expect(get(matches)).toEqual([]);
  });
});
