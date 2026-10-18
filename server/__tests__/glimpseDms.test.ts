// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Glimpse's DMs (MICA-393): the policy `Glimpse.ts` registers with `dms` at import, and the push
 * a send makes on Glimpse's own channel.
 *
 * A suite of its own rather than a case in `glimpse.test.ts`, because that one mocks
 * `lib/appEvents` and so cannot see which net event a push actually leaves on. Here the channel
 * is the real one, and the shell's `mica:client:shell:appEvent` is what is read back.
 */

const { dbMock, handlers, policies } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured,
    policies: new Map<string, any>()
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/DiscordWebhook', () => ({ forwardReportFiled: vi.fn(), forwardAudit: vi.fn() }));

const bridge = vi.hoisted(() => ({ current: 'CIT_A' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    getSourceByCitizenId: () => 6,
    getSourcesByCitizenId: () => new Map([['CIT_B', 6]]),
    registerUsableItem: () => {}
  }
}));

// The real DM service, with each registration observed on its way through, so the policy
// Glimpse registered can be asked directly as well as through a send.
vi.mock('../services/DirectMessages', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/DirectMessages')>();
  return {
    ...real,
    registerDmPolicy: (appId: string, policy: unknown) => {
      // Recorded after the real one accepts it, so a refused second registration is not kept.
      real.registerDmPolicy(appId, policy as never);
      policies.set(appId, policy);
    }
  };
});

import { registerDmPolicy } from '../services/DirectMessages';
import { GLIMPSE_APP } from '../services/Glimpse';

const ADA = { id: 1, citizenid: 'CIT_A', app: 'glimpse', handle: 'ada', status: 'active' };
const LENA = { id: 2, citizenid: 'CIT_B', app: 'glimpse', handle: 'lena', status: 'active' };

const call = async (action: string, data: unknown) => {
  const handler = handlers.get(`mica:server:dms:${action}`);
  if (!handler) throw new Error(`no handler for ${action}`);
  bridge.current = 'CIT_A';
  (globalThis as any).source = 5;
  await handler('cb-1', data);
  return (globalThis.emitNet as any).mock.calls.at(-1)?.[3];
};

/** What reached the shell, on the one net event every app push travels. */
const shellPushes = (): any[] =>
  (globalThis.emitNet as any).mock.calls.filter(
    (args: unknown[]) => args[0] === 'mica:client:shell:appEvent'
  );

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.single.mockReset();
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(70);
  dbMock.update.mockResolvedValue(true);
  dbMock.single.mockResolvedValue(null);
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
  (globalThis as any).emitNet = vi.fn();
});

describe('the policy Glimpse registers', () => {
  it('is registered by Glimpse.ts at import, once, under its app id', () => {
    expect(GLIMPSE_APP).toBe('glimpse');
    expect(policies.has('glimpse')).toBe(true);
    // The positive twin of "a second registration throws": the slot is genuinely taken.
    expect(() =>
      registerDmPolicy('glimpse', {
        canSend: () => true,
        notify: () => ({ title: '', message: '', deepLink: '' })
      })
    ).toThrow("'glimpse' already has a DM policy");
  });

  it('lets any two accounts send: blocks are the service’s rule, asked before this one', async () => {
    const policy = policies.get('glimpse');
    expect(await policy.canSend(ADA, LENA)).toBe(true);
    expect(await policy.canSend(LENA, ADA)).toBe(true);
    expect(policy.canRead).toBeUndefined();
  });

  it('notifies with the sender’s handle and the text, opening the thread on that handle', () => {
    const policy = policies.get('glimpse');
    expect(policy.notify(ADA, 'hello')).toEqual({
      title: '@ada',
      message: 'hello',
      deepLink: 'glimpse?dmHandle=ada'
    });
    // Blabber's cap: a toast is a preview, not the message.
    expect(policy.notify(ADA, 'x'.repeat(500)).message).toHaveLength(120);
  });
});

describe('a Glimpse DM, sent', () => {
  it('pushes to the recipient on Glimpse’s channel, not Blabber’s, with Glimpse’s notice', async () => {
    dbMock.single.mockResolvedValueOnce(ADA);
    dbMock.single.mockResolvedValueOnce(LENA);

    const reply = await call('send', {
      app: 'glimpse',
      account_id: 1,
      peer_account_id: 2,
      body: 'hello'
    });

    expect(reply).toMatchObject({ id: 70, from_account: 1, to_account: 2, body: 'hello' });
    // Both account reads scoped to Glimpse, the app the payload named.
    expect(dbMock.single.mock.calls[0][1]).toEqual([1, 'CIT_A', 'glimpse']);
    expect(dbMock.single.mock.calls[1][1]).toEqual([2, 'glimpse']);

    const pushed = shellPushes();
    expect(pushed).toHaveLength(1);
    // To the recipient's source, as appEventChannel('glimpse') addresses it.
    expect(pushed[0][1]).toBe(6);
    expect(pushed[0][2]).toMatchObject({
      app: 'glimpse',
      event: 'dm',
      payload: { peer_account_id: 1, handle: 'ada' },
      notify: { title: '@ada', message: 'hello' },
      deepLink: 'glimpse?dmHandle=ada'
    });
    expect(pushed[0][2].app).not.toBe('blabber');
  });
});
