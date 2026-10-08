// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MICA-333: `SendSystemEmail` answers the mail once its row exists, whatever notifying does.
 *
 * One try wrapped the insert and both notify steps, so a throw from the live push or the app
 * event after the row was written answered `null`. The calling script reads null as "not
 * delivered" — and one that retries puts a second copy in the player's inbox.
 *
 * The throws are injected where they would really come from: `emitNet` for the live push, and
 * the bridge lookup `appEvents` makes for the notification.
 */
const { dbMock, bridge } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
  bridge: {
    getAllPlayers: vi.fn(),
    getSourceByCitizenId: vi.fn(),
    getSourcesByCitizenId: vi.fn()
  }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    ...bridge,
    getPlayer: () => null,
    getCitizenId: () => null,
    registerUsableItem: () => {}
  }
}));

import { SendSystemEmail } from '../services/Mail';

const CITIZEN = 'CID_A';
const SOURCE = 7;
const MAIL_ID = 42;
const SUBJECT = 'Your statement, private';
const BODY = 'balance 12, also private';
const LIVE_PUSH = 'mica:client:mail:receive';

const send = () => SendSystemEmail(CITIZEN, { sender: 'Bank', subject: SUBJECT, content: BODY });

let error: ReturnType<typeof vi.spyOn>;
let emitNet: ReturnType<typeof vi.fn>;

const logged = (): string => error.mock.calls.flat().map(String).join('\n');
const emitted = (event: string) =>
  emitNet.mock.calls.filter((call: unknown[]) => call[0] === event);

beforeEach(() => {
  dbMock.insert.mockReset().mockResolvedValue(MAIL_ID);
  dbMock.query.mockReset().mockResolvedValue({ affectedRows: 1 });
  bridge.getAllPlayers.mockReset().mockReturnValue({
    [SOURCE]: { PlayerData: { citizenid: CITIZEN } }
  });
  bridge.getSourceByCitizenId.mockReset().mockReturnValue(SOURCE);
  bridge.getSourcesByCitizenId.mockReset().mockReturnValue(new Map([[CITIZEN, SOURCE]]));
  emitNet = vi.fn();
  (globalThis as any).emitNet = emitNet;
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  error.mockRestore();
});

describe('SendSystemEmail after the row is written', () => {
  it('answers the mail when the live push throws, logs once, and still notifies', async () => {
    emitNet.mockImplementation((event: string) => {
      if (event === LIVE_PUSH) throw new Error('bad source');
    });

    const sent = await send();

    expect(sent?.id).toBe(MAIL_ID);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(logged()).toMatch(/stored system mail 42 for CID_A, but its live push failed/);
    // The second step ran regardless: the app event went out.
    expect(emitted('mica:client:shell:appEvent')).toHaveLength(1);
  });

  it('answers the mail when the app event step throws, and logs once', async () => {
    bridge.getSourceByCitizenId.mockImplementation(() => {
      throw new Error('bridge unavailable');
    });

    const sent = await send();

    expect(sent?.id).toBe(MAIL_ID);
    expect(error).toHaveBeenCalledTimes(1);
    expect(logged()).toMatch(/stored system mail 42 for CID_A, but its app event failed/);
    expect(emitted(LIVE_PUSH)).toHaveLength(1);
  });

  it('never logs the subject or the body', async () => {
    emitNet.mockImplementation(() => {
      throw new Error('bad source');
    });

    await send();

    expect(logged()).not.toContain(SUBJECT);
    expect(logged()).not.toContain(BODY);
  });
});

describe('SendSystemEmail when the insert fails', () => {
  it('answers null and logs the driver reason, not the parameters', async () => {
    dbMock.insert.mockRejectedValue(
      new Error(
        'mica was unable to execute a query!\n' +
          'Query: INSERT INTO `mica_mail` (...) VALUES (...)\n' +
          `${JSON.stringify([CITIZEN, 'Bank', SUBJECT, BODY])}\n` +
          "Table 'mica_mail' doesn't exist"
      )
    );

    const sent = await send();

    expect(sent).toBeNull();
    expect(emitNet).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(logged()).toMatch(/Error in SendSystemEmail: Table 'mica_mail' doesn't exist/);
    expect(logged()).not.toContain(SUBJECT);
  });
});
