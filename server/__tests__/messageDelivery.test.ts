// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __resetRateLimits } from '../lib/rateLimit';

/**
 * A sent message has to reach the other people in the thread.
 *
 * It did not. `send` wrote the row, returned it to the sender, and told nobody — so a
 * text never arrived on its own, between two real players or otherwise. The recipient
 * saw it only if they happened to re-open the conversation and it re-fetched, and apps
 * are resident across an open/close cycle, so often not even then.
 *
 * The shell's `receiveMessage` route had existed the whole time, complete with a toast
 * and inline reply. Nothing ever fired it.
 */

const { participants, emitted, sources, dbMock, handlers, player } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previousOnNet = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previousOnNet === 'function' ? previousOnNet(event, handler) : undefined;
  };

  return {
    participants: { rows: [] as any[] },
    emitted: [] as { event: string; target: number; payload: any }[],
    sources: new Map<string, number>(),
    /**
     * `query` backs `Blocklist.ts`'s `blockedBy` (MICA-64, batched in MICA-197) — one
     * `IN (…)` for the whole thread rather than the `scalar` `isBlocked` this used to call
     * once per participant. An empty result is "nobody blocked", which keeps every existing
     * test in this file exactly as unblocked as it always was.
     */
    dbMock: {
      query: vi.fn(async () => []),
      insert: vi.fn(),
      update: vi.fn(),
      single: vi.fn(),
      scalar: vi.fn(async () => null)
    },
    handlers: captured,
    // The reaction handlers below go through `ServiceEndpoint`'s wrapper, which resolves
    // the caller from `FrameworkBridge.getPlayer(source)` — unlike `deliverToParticipants`,
    // which is called directly and never touches it. `null` keeps every existing test in
    // this file exactly as unauthenticated as it always was; the reaction tests set it.
    player: { current: null as { citizenid: string; source: number } | null }
  };
});

vi.mock('../lib/Database', () => ({ Database: dbMock }));

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getSourceByCitizenId: (citizenid: string) => sources.get(citizenid) ?? null,
    /**
     * The batched twin `deliverToParticipants` asks now (MICA-197). Backed by the same
     * `sources` map, so a test still says who is online by setting one entry — what changed
     * is that the whole thread is asked about at once instead of one participant at a time.
     */
    getSourcesByCitizenId: (citizenids: readonly string[]) => {
      const found = new Map<string, number>();
      for (const citizenid of citizenids) {
        const src = sources.get(citizenid);
        if (src !== undefined) found.set(citizenid, src);
      }
      return found;
    },
    getPlayer: (source: number) =>
      player.current && player.current.source === source
        ? { citizenid: player.current.citizenid, source, setMeta: () => {} }
        : null
  }
}));

vi.mock('../services/Conversations', () => ({
  conversations: { repo: { findParticipants: async () => participants.rows } }
}));

(globalThis as any).emitNet = (event: string, target: number, payload: any) => {
  emitted.push({ event, target, payload });
};

const message = { id: 42, conversation_id: 7, citizenid: 'SENDER', message: 'hi' } as any;

let deliverToParticipants: any;

beforeEach(async () => {
  emitted.length = 0;
  sources.clear();
  participants.rows = [];
  dbMock.query.mockReset().mockResolvedValue([]);
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.single.mockReset();
  // Not `.mockReset()`: that would drop the default `async () => null` implementation
  // set in `vi.hoisted` above, which every pre-existing test in this file relies on to
  // keep `isBlocked` answering "nobody's blocked" without having to say so itself.
  dbMock.scalar.mockClear();
  player.current = null;
  __resetRateLimits();
  ({ deliverToParticipants } = await import('../services/Messages'));
});

/** Drives a registered `gphone:server:messages:<action>` handler as `citizenid`@`source`. */
const call = async (action: string, source: number, citizenid: string, data: unknown) => {
  player.current = { citizenid, source };
  (globalThis as any).source = source;
  (globalThis as any).emitNet = vi.fn();
  const handler = handlers.get(`gphone:server:messages:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

describe('deliverToParticipants', () => {
  it('pushes to an online participant', async () => {
    participants.rows = [
      { citizenid: 'SENDER', status: 'active' },
      { citizenid: 'OTHER', status: 'active' }
    ];
    sources.set('OTHER', 3);

    await deliverToParticipants(7, 'SENDER', { name: 'A B', phone: '5550100' }, message);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('gphone:client:messages:received');
    expect(emitted[0].target).toBe(3);
  });

  /**
   * MICA-64. Blocking a sender withholds only the live push — the row is still
   * written, the same as an offline participant — since hiding history retroactively or
   * making the thread itself disappear is a larger, more decision-heavy feature this
   * pass does not take a position on.
   */
  it('skips the live push to a participant who has blocked the sender', async () => {
    participants.rows = [
      { citizenid: 'SENDER', status: 'active' },
      { citizenid: 'OTHER', status: 'active' }
    ];
    sources.set('OTHER', 3);
    // The batched read answers with the citizenids that *have* blocked this number.
    dbMock.query.mockResolvedValueOnce([{ citizenid: 'OTHER' }] as never);

    await deliverToParticipants(7, 'SENDER', { name: 'A B', phone: '5550100' }, message);

    expect(emitted).toEqual([]);
  });

  it('asks the blocklist once, with the sender phone and every recipient citizenid', async () => {
    participants.rows = [
      { citizenid: 'OTHER', status: 'active' },
      { citizenid: 'THIRD', status: 'active' }
    ];
    sources.set('OTHER', 3);
    sources.set('THIRD', 4);

    await deliverToParticipants(7, 'SENDER', { name: 'A B', phone: '5550100' }, message);

    // One query for the whole thread, not one per participant (MICA-197).
    expect(dbMock.query).toHaveBeenCalledTimes(1);
    expect(dbMock.query).toHaveBeenCalledWith(expect.any(String), ['OTHER', 'THIRD', '5550100']);
  });

  /**
   * An offline participant is never asked about either. The push is withheld from them
   * regardless, so a blocklist round trip on their behalf would be work with no consequence.
   */
  it('asks the blocklist only about the people it is about to push to', async () => {
    participants.rows = [
      { citizenid: 'OTHER', status: 'active' },
      { citizenid: 'AWAY', status: 'active' }
    ];
    sources.set('OTHER', 3);

    await deliverToParticipants(7, 'SENDER', { name: 'A B', phone: '5550100' }, message);

    expect(dbMock.query).toHaveBeenCalledWith(expect.any(String), ['OTHER', '5550100']);
  });

  it('still delivers when the sender has no known phone number, rather than blocking blindly', async () => {
    participants.rows = [{ citizenid: 'OTHER', status: 'active' }];
    sources.set('OTHER', 3);

    await deliverToParticipants(7, 'SENDER', { name: 'A B', phone: null }, message);

    expect(emitted).toHaveLength(1);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  /**
   * Nobody online means nothing to ask and nothing to send — the blocklist is not consulted
   * at all, which is what keeps an all-offline thread from costing a query per message.
   */
  it('asks nothing when every other participant is offline', async () => {
    participants.rows = [
      { citizenid: 'OTHER', status: 'active' },
      { citizenid: 'AWAY', status: 'active' }
    ];

    await deliverToParticipants(7, 'SENDER', { name: 'A B', phone: '5550100' }, message);

    expect(emitted).toEqual([]);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('does not echo back to the sender', async () => {
    participants.rows = [{ citizenid: 'SENDER', status: 'active' }];
    sources.set('SENDER', 1);

    await deliverToParticipants(7, 'SENDER', { name: null, phone: null }, message);

    expect(emitted).toEqual([]);
  });

  it('skips an offline participant — the row is written, they fetch it later', async () => {
    participants.rows = [{ citizenid: 'OTHER', status: 'active' }];

    await deliverToParticipants(7, 'SENDER', { name: null, phone: null }, message);

    expect(emitted).toEqual([]);
  });

  it('skips someone who left the thread', async () => {
    participants.rows = [{ citizenid: 'OTHER', status: 'left' }];
    sources.set('OTHER', 3);

    await deliverToParticipants(7, 'SENDER', { name: null, phone: null }, message);

    expect(emitted).toEqual([]);
  });

  it('sends the shape the shell already routes', async () => {
    // `receiveMessage` reads these field names; a mismatch is a silent no-op toast.
    participants.rows = [{ citizenid: 'OTHER', status: 'active' }];
    sources.set('OTHER', 3);

    await deliverToParticipants(7, 'SENDER', { name: 'Marla Vance', phone: '5550101' }, message);

    expect(emitted[0].payload).toMatchObject({
      conversation_id: 7,
      message: 'hi',
      senderName: 'Marla Vance',
      phone: '5550101'
    });
  });

  it('delivers to every other participant in a group', async () => {
    participants.rows = [
      { citizenid: 'SENDER', status: 'active' },
      { citizenid: 'A', status: 'active' },
      { citizenid: 'B', status: 'active' },
      { citizenid: 'C', status: 'active' }
    ];
    sources.set('A', 1);
    sources.set('B', 2);
    // C is offline.

    await deliverToParticipants(7, 'SENDER', { name: null, phone: null }, message);

    expect(emitted.map((e) => e.target).toSorted()).toEqual([1, 2]);
  });
});

/**
 * MICA-143: reactions on Messages, storing into `gphone_messages_reactions` —
 * `server/services/Messages.ts`'s own child table, not the shared `gphone_account_reactions`
 * Blabber DMs use. See the docblock above `requireReactableMessage` in that file for why: that
 * table's `account_id` is a foreign key onto `gphone_accounts`, and native Messages has no
 * account layer to key on — it authorizes by citizenid, the same identity conversation
 * membership already uses.
 */
describe('reactions on Messages (MICA-143)', () => {
  // `call` reassigns the shared global `emitNet` per invocation (necessary so its own return
  // value can be read back), which would otherwise leak into `deliverToParticipants` above if
  // test order ever changed. Restored after every test in this block for that reason.
  afterEach(() => {
    (globalThis as any).emitNet = (event: string, target: number, payload: any) => {
      emitted.push({ event, target, payload });
    };
  });

  const activeMessage = { ...message, status: 'active' };

  /** `messageRepo.findById` finds the message, and `isMember` confirms current membership. */
  const asParticipant = (row: unknown = activeMessage) => {
    dbMock.single.mockImplementation(async (sql: string) => {
      if (sql.includes('gphone_messages_participants')) return { placeholder: 1 };
      if (sql.includes('gphone_messages')) return row;
      throw new Error(`unexpected single(): ${sql}`);
    });
  };

  describe('react', () => {
    it('inserts a reaction once the caller is confirmed as a current participant', async () => {
      asParticipant();
      dbMock.insert.mockResolvedValue(1);

      const reply = await call('react', 5, 'OTHER', { message_id: 42, emoji: '👍' });

      expect(reply).toBe(true);
      expect(dbMock.insert).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO `gphone_messages_reactions`'),
        [42, 'OTHER', '👍']
      );
    });

    it('refuses a reactor who is not a participant in the thread', async () => {
      dbMock.single.mockImplementation(async (sql: string) => {
        if (sql.includes('gphone_messages_participants')) return undefined;
        if (sql.includes('gphone_messages')) return activeMessage;
        throw new Error(`unexpected single(): ${sql}`);
      });

      const reply = await call('react', 5, 'STRANGER', { message_id: 42, emoji: '👍' });

      expect(reply).toEqual({ error: 'Not a participant in this conversation.' });
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('refuses to react to a message that has been unsent, but still confirms membership first', async () => {
      asParticipant({ ...activeMessage, status: 'deleted' });

      const reply = await call('react', 5, 'OTHER', { message_id: 42, emoji: '👍' });

      expect(reply).toEqual({ error: 'That message is no longer available.' });
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('rejects anything that is not a single plausible emoji, before touching the database', async () => {
      const reply = await call('react', 5, 'OTHER', {
        message_id: 42,
        emoji: 'this is not a single emoji, it is far too long a string'
      });

      expect(reply).toMatchObject({ error: expect.stringContaining('emoji') });
      expect(dbMock.single).not.toHaveBeenCalled();
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('tapping the same emoji twice is idempotent, not an error', async () => {
      asParticipant();
      dbMock.insert.mockRejectedValue(new Error("Duplicate entry '42-OTHER-👍' for key 'x'"));

      const reply = await call('react', 5, 'OTHER', { message_id: 42, emoji: '👍' });

      expect(reply).toBe(true);
    });
  });

  describe('unreact', () => {
    it("deletes scoped to the caller's own citizenid, with no membership check at all", async () => {
      dbMock.update.mockResolvedValue(true);

      const reply = await call('unreact', 5, 'OTHER', { message_id: 42, emoji: '👍' });

      expect(reply).toBe(true);
      expect(dbMock.update).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM `gphone_messages_reactions`'),
        [42, 'OTHER', '👍']
      );
      // Taking back your own reaction stays possible even after leaving the thread, the
      // same "withdrawing stays possible forever" reasoning `delete` documents for the
      // message itself — so this never even reads the message row to check membership.
      expect(dbMock.single).not.toHaveBeenCalled();
    });
  });

  describe('reactionsFor', () => {
    it("reports counts and the caller's own reactions only for messages they can currently see", async () => {
      dbMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('gphone_messages_participants')) return [{ id: 42 }];
        if (sql.includes('GROUP BY')) {
          return [
            { message_id: 42, emoji: '👍', total: 2 },
            { message_id: 42, emoji: '🔥', total: 1 }
          ];
        }
        return [{ message_id: 42, emoji: '👍' }];
      });

      const reply = await call('reactionsFor', 5, 'OTHER', { target_ids: [42] });

      expect(reply).toEqual({ 42: { counts: { '👍': 2, '🔥': 1 }, mine: ['👍'] } });
    });

    it('omits a message the caller is not currently a live participant in — never trusting the id alone', async () => {
      dbMock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('gphone_messages_participants')) return []; // not visible to this caller
        throw new Error(`unexpected query(): ${sql}`);
      });

      const reply = await call('reactionsFor', 5, 'OUTSIDER', { target_ids: [999] });

      expect(reply).toEqual({});
    });
  });
});
