// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `sendFromLine` (MICA-223): a text from something that is not a player lands in a thread
 * between the recipient's phone and the line, on a row the recipient owns and a label every
 * reader can tell apart from their own words.
 */
const { dbMock, convRepo, sources, phones } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(async () => []),
    insert: vi.fn(async () => 99),
    update: vi.fn(async () => true),
    single: vi.fn(async () => null),
    scalar: vi.fn(async () => null)
  },
  convRepo: {
    findParticipants: vi.fn(async () => [] as any[]),
    findExternalThread: vi.fn(async () => null as any),
    createConversation: vi.fn(async () => 7),
    addParticipant: vi.fn(async () => true)
  },
  sources: new Map<string, number>(),
  phones: { forCitizen: vi.fn(async () => 'PHONE_A') }
}));

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => null,
    getSourceByCitizenId: (citizenid: string) => sources.get(citizenid) ?? null,
    getSourcesByCitizenId: (citizenids: readonly string[]) => {
      const found = new Map<string, number>();
      for (const citizenid of citizenids) {
        const src = sources.get(citizenid);
        if (src !== undefined) found.set(citizenid, src);
      }
      return found;
    }
  }
}));
vi.mock('../services/Conversations', () => ({ conversations: { repo: convRepo } }));
vi.mock('../services/Phones', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/Phones')>()),
  phoneForCitizen: (citizenid: string) => phones.forCitizen(citizenid)
}));

import { sendFromLine, lineKey, lineLabel } from '../services/Messages';

const CID = 'CIT_A';
const CAB = { name: 'Downtown Cab', number: '5550199' };

/** The INSERT into `mica_messages`, as `Repository.create` issued it. */
const messageInsert = () =>
  dbMock.insert.mock.calls.find(([sql]) => String(sql).includes('`mica_messages`')) as
    [string, unknown[]] | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  sources.clear();
  convRepo.findExternalThread.mockResolvedValue(null);
  convRepo.createConversation.mockResolvedValue(7);
  convRepo.findParticipants.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(99);
  dbMock.query.mockResolvedValue([]);
  (globalThis as any).emitNet = vi.fn();
});

describe('the far side of a thread with a line', () => {
  it('is keyed on the number when there is one, else the name, and never looks like a phone id', () => {
    expect(lineKey({ name: 'Downtown Cab', number: '5550199' })).toBe('ext:5550199');
    expect(lineKey({ name: 'Downtown Cab', number: null })).toBe('ext:downtown cab');
    // Phone ids are bare hex; the prefix is what keeps the two namespaces apart.
    expect(lineKey({ name: null, number: 'abcdef0123456789abcdef0123456789' })).toMatch(/^ext:/);
  });

  it('is labelled by name when both are given, and by number when only that is', () => {
    expect(lineLabel({ name: 'Downtown Cab', number: '5550199' })).toBe('Downtown Cab');
    expect(lineLabel({ name: null, number: '5550199' })).toBe('5550199');
  });
});

describe('sendFromLine', () => {
  it('creates the thread on the recipient phone with the line in the pair columns', async () => {
    const result = await sendFromLine(CID, CAB, 'Your ride is outside.', undefined);

    expect(phones.forCitizen).toHaveBeenCalledWith(CID);
    expect(convRepo.findExternalThread).toHaveBeenCalledWith('PHONE_A', 'ext:5550199');
    expect(convRepo.createConversation).toHaveBeenCalledWith({
      citizenid: CID,
      is_group: false,
      name: 'Downtown Cab',
      participant_a: 'PHONE_A',
      participant_b: 'ext:5550199'
    });
    // The recipient is the thread's only participant; a line has no players row to name.
    expect(convRepo.addParticipant).toHaveBeenCalledWith(7, CID, 'PHONE_A', 'member');
    expect(result).toEqual({ conversationId: 7, messageId: 99, delivered: false });
  });

  it('reuses the thread the line already has with that phone', async () => {
    convRepo.findExternalThread.mockResolvedValue({ id: 3 });

    const result = await sendFromLine(CID, CAB, 'Still outside.', undefined);

    expect(convRepo.createConversation).not.toHaveBeenCalled();
    expect(convRepo.addParticipant).not.toHaveBeenCalled();
    expect(result.conversationId).toBe(3);
  });

  it('owns the row to the recipient and marks who really sent it', async () => {
    await sendFromLine(CID, CAB, 'Your ride is outside.', undefined);

    const insert = messageInsert();
    expect(insert).toBeDefined();
    const [sql, params] = insert!;
    expect(sql).toContain('`citizenid`');
    expect(sql).toContain('`external_sender`');
    expect(params).toContain(CID);
    expect(params).toContain('Downtown Cab');
  });

  it('pushes to the recipient when they are online, and says so', async () => {
    convRepo.findParticipants.mockResolvedValue([{ citizenid: CID, status: 'active' }]);
    sources.set(CID, 5);

    const result = await sendFromLine(CID, CAB, 'Your ride is outside.', undefined);

    expect(result.delivered).toBe(true);
    expect(globalThis.emitNet).toHaveBeenCalledWith(
      'mica:client:messages:received',
      5,
      expect.objectContaining({
        conversation_id: 7,
        message: 'Your ride is outside.',
        senderName: 'Downtown Cab',
        phone: '5550199'
      })
    );
  });

  it('writes the row and pushes nothing when the recipient is offline', async () => {
    convRepo.findParticipants.mockResolvedValue([{ citizenid: CID, status: 'active' }]);

    const result = await sendFromLine(CID, CAB, 'Your ride is outside.', undefined);

    expect(messageInsert()).toBeDefined();
    expect(result.delivered).toBe(false);
    expect(globalThis.emitNet).not.toHaveBeenCalled();
  });

  it('takes the thread the other racer created when the pair key refuses a second', async () => {
    convRepo.createConversation.mockRejectedValue(new Error("Duplicate entry 'x' for key"));
    convRepo.findExternalThread.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 11 });

    const result = await sendFromLine(CID, CAB, 'Your ride is outside.', undefined);

    expect(result.conversationId).toBe(11);
    expect(convRepo.addParticipant).toHaveBeenCalledWith(11, CID, 'PHONE_A', 'member');
  });

  it('lets any other failure to create the thread propagate', async () => {
    convRepo.createConversation.mockRejectedValue(new Error('connection lost'));

    await expect(sendFromLine(CID, CAB, 'hi', undefined)).rejects.toThrow('connection lost');
  });
});
