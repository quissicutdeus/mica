// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DarkchatChannel, DarkchatJoined, DarkchatMember } from '@mica/shared/types';
import {
  DARKCHAT_CODE_ALPHABET,
  DARKCHAT_CODE_LENGTH,
  mockDarkchatChannels,
  mockDarkchatMembers,
  myDarkchatMember,
  newMemberHandle,
  type MockDarkchatChannel,
  type MockDarkchatMember
} from '../darkchat';
import type { MockHandler } from '../registry';

let nextChannelId = 100;
let nextMemberSeq = 100;

const CODE_PATTERN = new RegExp(`^[${DARKCHAT_CODE_ALPHABET}]{${DARKCHAT_CODE_LENGTH}}$`);

const newCode = (): string => {
  for (;;) {
    let code = '';
    for (let i = 0; i < DARKCHAT_CODE_LENGTH; i += 1) {
      code += DARKCHAT_CODE_ALPHABET[Math.floor(Math.random() * DARKCHAT_CODE_ALPHABET.length)];
    }
    if (!mockDarkchatChannels.some((c) => c.code === code)) return code;
  }
};

const requireText = (value: unknown, max: number, what: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text.length > max) throw new Error(`Pick a ${what} of 1–${max} characters.`);
  return text;
};

/** The channel and the player's live row in it, or a refusal: non-members get nothing. */
const membership = (channelId: number) => {
  const me = myDarkchatMember(channelId);
  const channel = mockDarkchatChannels.find((c) => c.id === channelId);
  if (!me || !channel) throw new Error('You are not in that channel.');
  return { me, channel };
};

const ownership = (channelId: number) => {
  const found = membership(channelId);
  if (found.channel.owner_member_id !== found.me.id) {
    throw new Error('Only the channel owner can do that.');
  }
  return found;
};

const aliasTaken = (channelId: number, alias: string) =>
  mockDarkchatMembers.some(
    (m) => m.channel_id === channelId && !m.left && m.alias.toLowerCase() === alias.toLowerCase()
  );

const toChannel = (channel: MockDarkchatChannel): DarkchatChannel => {
  const me = myDarkchatMember(channel.id)!;
  return {
    id: channel.id,
    name: channel.name,
    my_member_id: me.id,
    my_alias: me.alias,
    is_owner: channel.owner_member_id === me.id
  };
};

const addMe = (channelId: number, alias: string): MockDarkchatMember => {
  let id = newMemberHandle();
  while (mockDarkchatMembers.some((m) => m.id === id)) id = newMemberHandle();
  const row: MockDarkchatMember = {
    id,
    seq: nextMemberSeq++,
    channel_id: channelId,
    alias,
    citizenid: 'PLAYER',
    me: true,
    left: false
  };
  mockDarkchatMembers.push(row);
  return row;
};

/**
 * Dark Chat's channels (MICA-254), answering every action `server/services/Darkchat.ts`
 * declares, with its rules: every action past `create`, `join` and `list` names a channel the
 * player must be a live member of, and the code and member actions are the owner's alone.
 */
export const mocks: Record<string, MockHandler> = {
  'darkchat:create': ({ name, alias }: { name?: string; alias?: string }): DarkchatJoined => {
    const channelName = requireText(name, 32, 'channel name');
    const myAlias = requireText(alias, 24, 'alias');
    const channel: MockDarkchatChannel = {
      id: nextChannelId++,
      name: channelName,
      code: newCode(),
      owner_member_id: ''
    };
    mockDarkchatChannels.push(channel);
    channel.owner_member_id = addMe(channel.id, myAlias).id;
    return { channel: toChannel(channel), code: channel.code };
  },

  'darkchat:join': ({ code, alias }: { code?: string; alias?: string }): DarkchatJoined => {
    const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const myAlias = requireText(alias, 24, 'alias');
    const channel = CODE_PATTERN.test(normalized)
      ? mockDarkchatChannels.find((c) => c.code === normalized)
      : undefined;
    // Removed is for good, and answered exactly as a code that does not exist.
    const removed = mockDarkchatMembers.some(
      (m) => m.channel_id === channel?.id && m.me && m.removed
    );
    if (!channel || removed) throw new Error('That code did not work.');
    if (myDarkchatMember(channel.id)) throw new Error('You are already in that channel.');
    if (aliasTaken(channel.id, myAlias)) {
      throw new Error('Somebody in that channel already goes by that alias.');
    }
    // Always a new row: a rejoin is a new identity, as on the server.
    addMe(channel.id, myAlias);
    return { channel: toChannel(channel) };
  },

  'darkchat:list': (): DarkchatChannel[] =>
    mockDarkchatChannels
      .filter((c) => myDarkchatMember(c.id) !== undefined)
      .map(toChannel)
      .sort((a, b) => b.id - a.id),

  /** Live members, by alias and in alias order: nothing else to rank them by is answered. */
  'darkchat:members': ({ channel_id }: { channel_id: number }): DarkchatMember[] => {
    membership(channel_id);
    return mockDarkchatMembers
      .filter((m) => m.channel_id === channel_id && !m.left)
      .map((m) => ({ id: m.id, alias: m.alias }))
      .sort((a, b) => a.alias.toLowerCase().localeCompare(b.alias.toLowerCase()));
  },

  /** An owner who leaves hands the channel to its longest-standing live member. */
  'darkchat:leave': ({ channel_id }: { channel_id: number }): boolean => {
    const { me, channel } = membership(channel_id);
    me.left = true;
    if (channel.owner_member_id === me.id) {
      const heir = mockDarkchatMembers
        .filter((m) => m.channel_id === channel_id && !m.left)
        .sort((a, b) => a.seq - b.seq)[0];
      if (heir) channel.owner_member_id = heir.id;
    }
    return true;
  },

  'darkchat:code': ({ channel_id }: { channel_id: number }) => ({
    code: ownership(channel_id).channel.code
  }),

  'darkchat:rotateCode': ({ channel_id }: { channel_id: number }) => {
    const { channel } = ownership(channel_id);
    channel.code = newCode();
    return { code: channel.code };
  },

  'darkchat:removeMember': ({
    channel_id,
    member_id
  }: {
    channel_id: number;
    member_id: string;
  }): boolean => {
    const { me } = ownership(channel_id);
    // Never the owner themself, answered as nobody to remove — the server's predicate.
    const target = mockDarkchatMembers.find(
      (m) => m.id === member_id && m.id !== me.id && m.channel_id === channel_id && !m.left
    );
    if (!target) return false;
    target.left = true;
    target.removed = true;
    return true;
  }
};
