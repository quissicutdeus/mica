// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `micaseed text <firstname> <message>` — the row it hands the live push (MICA-422).
 *
 * The push is built from a row, not read back, so whatever the command passes is what every
 * member's phone draws. It was an object literal cast through `any`, missing both timestamps,
 * with an id read off a `query` result typed `any`. Typed as the `MessageRow` a real send passes,
 * it carries the id the insert answered and the times a real send stamps.
 */

const { dbMock, deliver, commands } = vi.hoisted(() => {
  const registered = new Map<string, (source: number, args: string[]) => void>();
  (globalThis as any).RegisterCommand = (name: string, fn: (s: number, a: string[]) => void) => {
    registered.set(name, fn);
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    deliver: vi.fn(),
    commands: registered
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../services/Messages', () => ({ deliverToParticipants: deliver }));
vi.mock('../services/Admin', () => ({ isAdmin: () => true }));
vi.mock('../lib/shell', () => ({ notifyPlayer: vi.fn() }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: { getPlayer: () => ({ citizenid: 'REAL_PLAYER', source: 5 }) }
}));

import '../services/Seed';
import { SEED_CHARACTERS } from '../lib/seed';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockImplementation(async (sql: string) =>
    String(sql).includes('FROM mica_messages_participants') ? [{ conversation_id: 41 }] : []
  );
  dbMock.insert.mockResolvedValue(907);
  deliver.mockResolvedValue(true);
});

const runText = async (args: string[]) => {
  commands.get('micaseed')!(5, args);
  await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
};

describe('micaseed text', () => {
  it('pushes the stored row: the inserted id, the thread, the sender and both times', async () => {
    const sender = SEED_CHARACTERS[0]!;
    await runText(['text', sender.firstname, 'hello', 'there']);

    const [conversationId, senderCitizenId, , row] = deliver.mock.calls[0]!;
    expect(conversationId).toBe(41);
    expect(senderCitizenId).toBe(sender.citizenid);
    expect(row).toMatchObject({
      id: 907,
      conversation_id: 41,
      citizenid: sender.citizenid,
      message: 'hello there',
      status: 'active'
    });
    expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
    expect(row.updated_at).toBe(row.created_at);
  });
});
