// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MICA-367: what `messages:send` reads of a thread, once, and the questions it answers from
 * that read instead of asking the database each one.
 *
 * `readForSend` replaces `isMember`, `nobodyElseIn` (MICA-349) and the post-write
 * `findParticipants` on the send path, and `lineKeyOfThread` replaces `lineKeyOf` there. What
 * the real database answers is `test:endpoints`' leftThread flow; this holds the statements'
 * shape and the in-memory predicates, each negative beside a positive twin.
 */
vi.mock('../lib/Database', () => ({
  Database: {
    single: vi.fn(async () => null),
    query: vi.fn(async () => []),
    insert: vi.fn(async () => 1),
    update: vi.fn(async () => true),
    scalar: vi.fn(async () => null)
  }
}));

import { Database } from '../lib/Database';
import { conversations } from '../services/Conversations';
import {
  isLiveMemberOn,
  lineKeyOfThread,
  type ConversationRepository,
  type ParticipantRow
} from '../repositories/ConversationRepository';

const repo = conversations.repo as ConversationRepository;
const PHONE = 'b'.repeat(32);
const OTHER_PHONE = 'c'.repeat(32);
const CID = 'CIT_A';

const member = (over: Partial<ParticipantRow>): ParticipantRow =>
  ({
    id: 1,
    conversation_id: 7,
    citizenid: CID,
    device_id: PHONE,
    role: 'member',
    status: 'active',
    left_at: null,
    ...over
  }) as ParticipantRow;

const squash = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

beforeEach(() => {
  vi.mocked(Database.single).mockReset().mockResolvedValue(null);
  vi.mocked(Database.query).mockReset().mockResolvedValue([]);
});

describe('readForSend reads the thread and its live members, once each', () => {
  it('reads the thread by its primary key and the members through findParticipants', async () => {
    const thread = { is_group: 0, status: 'active', participant_a: null, participant_b: null };
    const members = [member({}), member({ id: 2, citizenid: 'CIT_B', device_id: OTHER_PHONE })];
    vi.mocked(Database.single).mockResolvedValueOnce(thread);
    vi.mocked(Database.query).mockResolvedValueOnce(members);

    await expect(repo.readForSend(7)).resolves.toEqual({ thread, participants: members });

    expect(Database.single).toHaveBeenCalledOnce();
    const [threadSql, threadParams] = vi.mocked(Database.single).mock.calls[0];
    expect(squash(threadSql)).toBe(
      'SELECT c.is_group, c.status, c.participant_a, c.participant_b ' +
        'FROM mica_messages_conversations c WHERE c.id = ?'
    );
    expect(threadParams).toEqual([7]);

    expect(Database.query).toHaveBeenCalledOnce();
    const [memberSql, memberParams] = vi.mocked(Database.query).mock.calls[0];
    expect(squash(memberSql)).toContain(
      'FROM mica_messages_participants p WHERE p.conversation_id = ? AND p.left_at IS NULL'
    );
    expect(memberParams).toEqual([7]);
  });

  it('answers a null thread for an id that names none', async () => {
    await expect(repo.readForSend(404)).resolves.toEqual({ thread: null, participants: [] });
  });
});

describe('isLiveMemberOn is the membership predicate, over rows already read', () => {
  it('is the citizen on the phone in hand, not left', () => {
    expect(isLiveMemberOn([member({})], CID, PHONE)).toBe(true);
  });

  it('is not the citizen on another phone, nor another citizen on this one', () => {
    expect(isLiveMemberOn([member({ device_id: OTHER_PHONE })], CID, PHONE)).toBe(false);
    expect(isLiveMemberOn([member({ citizenid: 'CIT_B' })], CID, PHONE)).toBe(false);
    // A legacy membership with no phone id is not the phone in hand.
    expect(isLiveMemberOn([member({ device_id: null })], CID, PHONE)).toBe(false);
  });

  it('is not a row that has left, whatever read handed it over', () => {
    expect(isLiveMemberOn([member({ left_at: '2026-10-15 12:00:00' })], CID, PHONE)).toBe(false);
  });

  it('is never anyone without a citizen or without a phone', () => {
    // `isMember` with no phone asked about the citizen alone; this refuses instead.
    expect(isLiveMemberOn([member({ device_id: '' })], CID, '')).toBe(false);
    expect(isLiveMemberOn([member({ citizenid: '' })], '', PHONE)).toBe(false);
    expect(isLiveMemberOn([], CID, PHONE)).toBe(false);
  });

  it('compares exactly, so it can only refuse more than the collated query', () => {
    expect(isLiveMemberOn([member({ citizenid: 'cit_a' })], CID, PHONE)).toBe(false);
    expect(isLiveMemberOn([member({ device_id: PHONE.toUpperCase() })], CID, PHONE)).toBe(false);
  });
});

describe("lineKeyOfThread is lineKeyOf over the send's thread row", () => {
  const row = (over: Record<string, unknown>) =>
    ({ is_group: 0, status: 'active', participant_a: PHONE, participant_b: null, ...over }) as any;

  it("answers the line's side of an active 1:1, on either side", () => {
    expect(lineKeyOfThread(row({ participant_b: 'ext:5550123' }))).toBe('ext:5550123');
    expect(lineKeyOfThread(row({ participant_a: 'ext:5550123', participant_b: PHONE }))).toBe(
      'ext:5550123'
    );
  });

  it('answers null for a group, a thread no longer active, a 1:1 of phones, or no row', () => {
    expect(lineKeyOfThread(row({ participant_b: 'ext:5550123', is_group: 1 }))).toBeNull();
    expect(lineKeyOfThread(row({ participant_b: 'ext:5550123', status: 'deleted' }))).toBeNull();
    expect(lineKeyOfThread(row({ participant_b: OTHER_PHONE }))).toBeNull();
    expect(lineKeyOfThread(null)).toBeNull();
  });
});
