import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { participants, emitted, sources } = vi.hoisted(() => ({
  participants: { rows: [] as any[] },
  emitted: [] as { event: string; target: number; payload: any }[],
  sources: new Map<string, number>()
}));

vi.mock('../lib/Database', () => ({
  Database: { query: vi.fn(async () => []) }
}));

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getSourceByCitizenId: (citizenid: string) => sources.get(citizenid) ?? null,
    getPlayer: () => null
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
  ({ deliverToParticipants } = await import('../services/Messages'));
});

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

    expect(emitted.map((e) => e.target).sort()).toEqual([1, 2]);
  });
});
