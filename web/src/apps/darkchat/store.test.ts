// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * Dark Chat's data layer (MICA-254). In-process facets, standing in for the shell, and one
 * `fetchNui` stub reached through the SDK's transport seam — the shape Glimpse's test uses.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { DarkchatChannel, DarkchatMessage } from '@mica/shared/types';
import * as fetchNuiModule from '../../nui/fetchNui';
import { registerNuiTransport } from '../../../../sdk/nui/transport';
import {
  channels,
  createChannel,
  isCode,
  leaveChannel,
  loadMessages,
  messages,
  normalizeCode,
  olderCursor,
  receiveMessage,
  receiveRemoval,
  sendMessage
} from './store';

type SvcPayload = { service?: string; action?: string; data?: unknown } | undefined;

const callsTo = (spy: { mock: { calls: unknown[][] } }, service: string, action: string) =>
  spy.mock.calls
    .map((call): SvcPayload => call[1] as SvcPayload)
    .filter((payload) => payload?.service === service && payload?.action === action)
    .map((payload) => payload?.data);

/** Opaque handles, as the server answers them. */
const ME = 'm5WkT0aQzE2pRu9C';
const VANDAL = 'q7Fz2LmP9xKc4TwB';

const channel: DarkchatChannel = {
  id: 7,
  name: 'Night Market',
  my_member_id: ME,
  my_alias: 'ghost',
  is_owner: false
};

const message = (id: number, extra: Partial<DarkchatMessage> = {}): DarkchatMessage => ({
  id,
  channel_id: 7,
  member_id: VANDAL,
  alias: 'vandal',
  bot: false,
  mine: false,
  body: `line ${id}`,
  created_at: '2026-10-17T10:00:00Z',
  ...extra
});

/** The server's push payload: the channel, and the message as another member reads it. */
const pushed = (row: Record<string, unknown>) => ({ channel_id: row.channel_id, message: row });

const ids = () => (get(messages)[7] ?? []).map((m) => m.id);

describe('darkchat store', () => {
  beforeEach(() => {
    registerNuiTransport((...args) => fetchNuiModule.fetchNui(...args));
    vi.restoreAllMocks();
    channels.set([channel]);
    messages.set({});
    olderCursor.set({});
  });

  it('normalizes a code to the unambiguous alphabet and eight characters', () => {
    expect(normalizeCode('k7qx-2mpv')).toBe('K7QX2MPV');
    expect(normalizeCode('O0I1L')).toBe('');
    expect(normalizeCode('ABCDEFGHJK')).toBe('ABCDEFGH');
    expect(isCode('K7QX2MPV')).toBe(true);
    expect(isCode('K7QX2MP')).toBe(false);
    expect(isCode('K7QX2MP0')).toBe(false);
  });

  it('holds a page oldest first, so the newest line is at the bottom', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({
      rows: [message(3), message(2), message(1)],
      nextCursor: 1
    });
    await loadMessages(7);
    expect(ids()).toEqual([1, 2, 3]);
    expect(get(olderCursor)[7]).toBe(1);
  });

  it('dedupes my own send against the push of the same message', async () => {
    messages.set({ 7: [message(1)] });
    const mine = message(9, { member_id: ME, alias: 'ghost', mine: true });
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(mine);

    await sendMessage(7, '  on my way  ');
    receiveMessage(pushed({ ...mine, mine: false }));

    expect(ids()).toEqual([1, 9]);
    // Recomputed from my member id, so an echo of my own line stays on my side.
    expect(get(messages)[7].find((m) => m.id === 9)?.mine).toBe(true);
  });

  it('trims what it sends and names the channel', async () => {
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(message(9));
    await sendMessage(7, '  hi  ');
    expect(callsTo(spy, 'darkchat_messages', 'send')).toEqual([{ channel_id: 7, body: 'hi' }]);
  });

  it('merges a push only into a thread already open, in a channel I am in', () => {
    receiveMessage(pushed({ ...message(4) }));
    expect(get(messages)[7]).toBeUndefined();

    messages.set({ 7: [message(1)] });
    receiveMessage(pushed({ ...message(5), channel_id: 99 }));
    receiveMessage({ ...message(6) });
    receiveMessage(pushed({ id: 'x', channel_id: 7, alias: 'a', body: 'b', member_id: null }));
    // A numeric member id is the old shape, and refused rather than trusted.
    receiveMessage(pushed({ ...message(8), member_id: 3 }));
    receiveMessage(pushed({ ...message(4), bot: true, member_id: null, alias: 'Lookout' }));

    expect(ids()).toEqual([1, 4]);
    expect(get(messages)[7][1]).toMatchObject({ bot: true, mine: false, alias: 'Lookout' });
  });

  it('creates through the untyped channels service with trimmed fields', async () => {
    const created: DarkchatChannel = { ...channel, id: 8, is_owner: true };
    const spy = vi
      .spyOn(fetchNuiModule, 'fetchNui')
      .mockResolvedValue({ channel: created, code: 'K7QX2MPV' });

    const joined = await createChannel(' Den ', ' ghost ');

    expect(callsTo(spy, 'darkchat', 'create')).toEqual([{ name: 'Den', alias: 'ghost' }]);
    expect(joined.code).toBe('K7QX2MPV');
    expect(get(channels).map((c) => c.id)).toEqual([8, 7]);
  });

  it('forgets a channel and its thread on leaving', async () => {
    messages.set({ 7: [message(1)] });
    olderCursor.set({ 7: null });
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue(true);

    await leaveChannel(7);

    expect(get(channels)).toEqual([]);
    expect(get(messages)[7]).toBeUndefined();
    expect(7 in get(olderCursor)).toBe(false);
  });

  it('drops a channel the owner removed me from, on the push', () => {
    messages.set({ 7: [message(1)] });
    receiveRemoval({ channel_id: '7' });
    expect(get(channels)).toHaveLength(1);
    receiveRemoval({ channel_id: 7 });
    expect(get(channels)).toEqual([]);
    expect(get(messages)[7]).toBeUndefined();
  });
});
