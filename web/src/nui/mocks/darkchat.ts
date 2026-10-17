// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Dark Chat's tables, in the browser (MICA-254). Shared by `services/darkchat.ts`,
 * `services/darkchat_messages.ts` and `services/reports.ts`, which files a report on a message
 * with the reporter's alias the way the server derives it.
 *
 * The seed is what the e2e lane asserts against: the player is `ghost` in "Night Market", a
 * channel `vandal` owns, so every owner-only action is refused there and a channel the player
 * creates is where they are allowed.
 */

/** Codes are eight of these: uppercase, and never 0/O, 1/I or L, which read alike. */
export const DARKCHAT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const DARKCHAT_CODE_LENGTH = 8;

export interface MockDarkchatChannel {
  id: number;
  name: string;
  code: string;
  /** The owner's member handle. */
  owner_member_id: string;
}

export interface MockDarkchatMember {
  /** The opaque handle every answer carries — never the row id, which is a global sequence. */
  id: string;
  /**
   * Join order, which the server keeps as the row id and uses for nothing a player sees but
   * who inherits a channel. Never answered: it would rank members and mark the owner.
   */
  seq: number;
  channel_id: number;
  alias: string;
  /** Never answered to the UI: who a member is stays on the server. */
  citizenid: string;
  /** True for the player's own row. The mock's stand-in for `citizenid = caller`. */
  me: boolean;
  left: boolean;
  /** Removed by the owner: for good, and a code that "did not work" from then on. */
  removed?: boolean;
}

export interface MockDarkchatMessage {
  id: number;
  channel_id: number;
  member_id: string | null;
  alias: string;
  bot: boolean;
  body: string;
  created_at: string;
}

const HANDLE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A fresh opaque member handle: sixteen random characters, nothing ordered in it. */
export const newMemberHandle = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => HANDLE_ALPHABET[b % HANDLE_ALPHABET.length]).join('');
};

/** The seed's handles, fixed so a test can name them, and as unordered as fresh ones. */
export const SEED_HANDLES = {
  vandal: 'q7Fz2LmP9xKc4TwB',
  nightowl: 'Xr3NbV8sJd1GyHe6',
  ghost: 'm5WkT0aQzE2pRu9C'
} as const;

/** The seeded channel's code, exported so a test names it rather than repeating it. */
export const SEED_CODE = 'K7QX2MPV';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const mockDarkchatChannels: MockDarkchatChannel[] = [
  { id: 1, name: 'Night Market', code: SEED_CODE, owner_member_id: SEED_HANDLES.vandal }
];

export const mockDarkchatMembers: MockDarkchatMember[] = [
  {
    id: SEED_HANDLES.vandal,
    seq: 1,
    channel_id: 1,
    alias: 'vandal',
    citizenid: 'DARK0001',
    me: false,
    left: false
  },
  {
    id: SEED_HANDLES.nightowl,
    seq: 2,
    channel_id: 1,
    alias: 'nightowl',
    citizenid: 'DARK0002',
    me: false,
    left: false
  },
  {
    id: SEED_HANDLES.ghost,
    seq: 3,
    channel_id: 1,
    alias: 'ghost',
    citizenid: 'PLAYER',
    me: true,
    left: false
  }
];

export const mockDarkchatMessages: MockDarkchatMessage[] = [
  {
    id: 1,
    channel_id: 1,
    member_id: SEED_HANDLES.vandal,
    alias: 'vandal',
    bot: false,
    body: 'Usual spot after midnight.',
    created_at: ago(42)
  },
  {
    id: 2,
    channel_id: 1,
    member_id: null,
    alias: 'Lookout',
    bot: true,
    body: 'Patrols doubled on Grove Street tonight.',
    created_at: ago(30)
  },
  {
    id: 3,
    channel_id: 1,
    member_id: SEED_HANDLES.nightowl,
    alias: 'nightowl',
    bot: false,
    body: 'Bring the van, not the bike.',
    created_at: ago(12)
  },
  {
    id: 4,
    channel_id: 1,
    member_id: SEED_HANDLES.ghost,
    alias: 'ghost',
    bot: false,
    body: 'On my way.',
    created_at: ago(5)
  }
];

/** The player's live member row in a channel, or undefined: the membership check. */
export const myDarkchatMember = (channelId: number): MockDarkchatMember | undefined =>
  mockDarkchatMembers.find((m) => m.channel_id === channelId && m.me && !m.left);
