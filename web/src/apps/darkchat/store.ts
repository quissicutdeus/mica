// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import type { ActionInput, ActionOutput } from '@mica/shared/contract';
import type { darkchatMessagesContract } from '@mica/shared/contracts/darkchat_messages';
import type {
  DarkchatChannel,
  DarkchatJoined,
  DarkchatMember,
  DarkchatMessage
} from '@mica/shared/types';
import { useService } from '@mica/sdk';

/**
 * Dark Chat's data layer (MICA-254), inside the app, for Glimpse's reason: an add-on cannot put
 * a store in core, so everything it holds lives in its own module.
 *
 * The channels go through `useService('darkchat')`, untyped, because their contract lives
 * beside the `defineService` in `server/services/Darkchat.ts` — an add-on's id may not be named
 * in `shared/`. Messages are `darkchat_messages`, whose contract is in `shared/contracts/`, so
 * their input and output types are read from there.
 *
 * Nothing here is identifying. A member is an alias and an id, and the only names this module
 * holds are the ones players typed into a channel.
 */

/** The longest channel name and alias, as `mica_darkchat` and its members table hold them. */
export const NAME_MAX = 32;
export const ALIAS_MAX = 24;
/** The longest body whose sealed form the column holds; the contract's `max`. */
export const BODY_MAX = 500;

/** A code is eight of these: uppercase, and never 0/O, 1/I or L, which read alike. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** Uppercased, and anything outside the alphabet dropped, as the player types. */
export const normalizeCode = (raw: string): string =>
  [...raw.toUpperCase()]
    .filter((ch) => CODE_ALPHABET.includes(ch))
    .join('')
    .slice(0, CODE_LENGTH);

export const isCode = (code: string): boolean =>
  code.length === CODE_LENGTH && [...code].every((ch) => CODE_ALPHABET.includes(ch));

// Resolved per call, as in Glimpse: a handle captured at module scope closes over the
// transport as it was at import time.
const channelService = () => useService('darkchat');
const messageService = () => useService('darkchat_messages');

type Messages = typeof darkchatMessagesContract;
type MessagePage = ActionOutput<Messages, 'list'>;

/** Every channel the player is a live member of. */
export const channels = writable<DarkchatChannel[]>([]);
export const channelsLoaded = writable(false);

/** A channel's messages, oldest first, keyed by channel. Absent until the channel is opened. */
export const messages = writable<Record<number, DarkchatMessage[]>>({});
/** Where the next older page starts, per channel; null once the oldest is on screen. */
export const olderCursor = writable<Record<number, number | null>>({});

const upsertChannel = (channel: DarkchatChannel) =>
  channels.update((list) => [channel, ...list.filter((c) => c.id !== channel.id)]);

export const forgetChannel = (channelId: number): void => {
  channels.update((list) => list.filter((c) => c.id !== channelId));
  messages.update((map) => {
    const next = { ...map };
    delete next[channelId];
    return next;
  });
  olderCursor.update((map) => {
    const next = { ...map };
    delete next[channelId];
    return next;
  });
};

/**
 * Merge rows into a channel's thread by id, oldest first. Every path in goes through here — a
 * page, my own send's answer, a push — so the same message arriving twice is one bubble.
 */
const mergeMessages = (channelId: number, rows: DarkchatMessage[]) =>
  messages.update((map) => {
    const byId = new Map((map[channelId] ?? []).map((m) => [m.id, m]));
    for (const row of rows) byId.set(row.id, row);
    return { ...map, [channelId]: [...byId.values()].sort((a, b) => a.id - b.id) };
  });

/**
 * Read the player's channels. Never rejects: it runs from `onAppForeground`, and a failure keeps
 * the last list rather than showing someone in three channels the empty state.
 */
export const loadChannels = async (): Promise<void> => {
  try {
    const rows = await channelService().call<DarkchatChannel[]>('list', {});
    channels.set(rows);
    channelsLoaded.set(true);
  } catch (error) {
    console.warn('micaOS Dark Chat: could not load your channels', error);
  }
};

/** Start a channel. The answer carries its code, which the caller shows once. */
export const createChannel = async (name: string, alias: string): Promise<DarkchatJoined> => {
  const joined = await channelService().call<DarkchatJoined>('create', {
    name: name.trim(),
    alias: alias.trim()
  });
  upsertChannel(joined.channel);
  return joined;
};

export const joinChannel = async (code: string, alias: string): Promise<DarkchatJoined> => {
  const joined = await channelService().call<DarkchatJoined>('join', {
    code: normalizeCode(code),
    alias: alias.trim()
  });
  upsertChannel(joined.channel);
  return joined;
};

export const leaveChannel = async (channelId: number): Promise<void> => {
  await channelService().call<boolean>('leave', { channel_id: channelId });
  forgetChannel(channelId);
};

/** Live members, by alias. Rejects on failure. */
export const loadMembers = (channelId: number): Promise<DarkchatMember[]> =>
  channelService().call<DarkchatMember[]>('members', { channel_id: channelId });

/** The channel's current code. The owner's alone; the server refuses anyone else. */
export const revealCode = async (channelId: number): Promise<string> =>
  (await channelService().call<{ code: string }>('code', { channel_id: channelId })).code;

/** Retire the code and issue another. Anyone holding the old one can no longer join. */
export const rotateCode = async (channelId: number): Promise<string> =>
  (await channelService().call<{ code: string }>('rotateCode', { channel_id: channelId })).code;

/** `memberId` is the member's opaque handle, as `members` answered it. */
export const removeMember = async (channelId: number, memberId: string): Promise<void> => {
  const removed = await channelService().call<boolean>('removeMember', {
    channel_id: channelId,
    member_id: memberId
  });
  if (removed === false) throw new Error('That member has already gone.');
};

const fetchPage = (channelId: number, cursor: number | null): Promise<MessagePage> => {
  const input: ActionInput<Messages, 'list'> = {
    channel_id: channelId,
    cursor: cursor ?? undefined
  };
  return messageService().call<MessagePage>('list', input);
};

/**
 * The newest page of a channel, replacing what was held: a message past the retention window
 * has to leave the screen, and a merge would keep it. Rejects on failure.
 */
export const loadMessages = async (channelId: number): Promise<void> => {
  const page = await fetchPage(channelId, null);
  messages.update((map) => ({ ...map, [channelId]: [...page.rows].sort((a, b) => a.id - b.id) }));
  olderCursor.update((map) => ({ ...map, [channelId]: page.nextCursor }));
};

/** The next older page, merged above what is on screen. Rejects on failure. */
export const loadOlder = async (channelId: number): Promise<void> => {
  const cursor = get(olderCursor)[channelId] ?? null;
  if (cursor === null) return;
  const page = await fetchPage(channelId, cursor);
  mergeMessages(channelId, page.rows);
  olderCursor.update((map) => ({ ...map, [channelId]: page.nextCursor }));
};

/** Post under my alias in the channel. The server's answer is the row, merged by id. */
export const sendMessage = async (channelId: number, body: string): Promise<DarkchatMessage> => {
  const input: ActionInput<Messages, 'send'> = { channel_id: channelId, body: body.trim() };
  const sent = await messageService().call<ActionOutput<Messages, 'send'>>('send', input);
  mergeMessages(channelId, [sent]);
  return sent;
};

/**
 * Narrow a pushed payload to a message. The bus promises a plain object and nothing more, so
 * every field is checked rather than asserted.
 */
export const asPushedMessage = (payload: Record<string, unknown>): DarkchatMessage | null => {
  const { id, channel_id, member_id, alias, bot, body, created_at } = payload;
  if (typeof id !== 'number' || typeof channel_id !== 'number') return null;
  if (typeof alias !== 'string' || typeof body !== 'string') return null;
  if (member_id !== null && typeof member_id !== 'string') return null;
  return {
    id,
    channel_id,
    member_id,
    alias,
    bot: bot === true,
    mine: payload.mine === true,
    body,
    created_at: typeof created_at === 'string' ? created_at : new Date().toISOString()
  };
};

/**
 * A message the server pushed: event `message`, payload `{ channel_id, message }`, sent to
 * every live member but its author. Merged only into a thread already open in this session —
 * one not yet opened reads the same row from `list` when it is — and only into a channel the
 * player is still in. `mine` is recomputed from my member id, in case my own send is echoed.
 */
export const receiveMessage = (payload: Record<string, unknown>): void => {
  const inner = payload.message;
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return;
  const message = asPushedMessage(inner as Record<string, unknown>);
  if (!message) return;
  const channel = get(channels).find((c) => c.id === message.channel_id);
  if (!channel || get(messages)[message.channel_id] === undefined) return;
  mergeMessages(message.channel_id, [
    {
      ...message,
      mine:
        message.mine || (message.member_id !== null && message.member_id === channel.my_member_id)
    }
  ]);
};

/**
 * The owner removed me: event `removed`, payload `{ channel_id }`. The channel leaves the list
 * and its thread leaves memory at once, rather than on the next read.
 */
export const receiveRemoval = (payload: Record<string, unknown>): void => {
  if (typeof payload.channel_id === 'number') forgetChannel(payload.channel_id);
};
