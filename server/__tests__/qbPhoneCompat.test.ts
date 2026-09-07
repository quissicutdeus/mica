// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * qb-phone's mail events land on `SendSystemEmail` with qb's payload shape (MICA-222), and
 * the two registrations sit on opposite sides of the boundary: the one that trusts `source`
 * is a net event, the one that takes a citizenid is local only.
 */
const { netHandlers, localHandlers, sendSystemEmail, bridge } = vi.hoisted(() => {
  const net = new Map<string, Function>();
  const local = new Map<string, Function>();
  const previousOnNet = (globalThis as any).onNet;
  const previousOn = (globalThis as any).on;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    net.set(event, handler);
    return typeof previousOnNet === 'function' ? previousOnNet(event, handler) : undefined;
  };
  (globalThis as any).on = (event: string, handler: Function) => {
    local.set(event, handler);
    return typeof previousOn === 'function' ? previousOn(event, handler) : undefined;
  };
  return {
    netHandlers: net,
    localHandlers: local,
    sendSystemEmail: vi.fn(async () => null),
    bridge: { player: { citizenid: 'CIT_A' } as { citizenid: string } | null }
  };
});

vi.mock('../services/Mail', () => ({ SendSystemEmail: sendSystemEmail }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: { getPlayer: () => bridge.player }
}));

import '../lib/qbPhoneCompat';
import { qbMailFrom } from '../lib/qbPhoneCompat';
import { __resetRateLimits } from '../lib/rateLimit';
import { QB_PHONE_SERVER_EVENTS } from '@mica/shared/qbPhoneEvents';

const qbMail = { sender: 'Los Santos Customs', subject: 'Your car', message: 'It is ready.' };

const fireNet = (event: string, ...args: unknown[]) => {
  (globalThis as any).source = 5;
  netHandlers.get(event)!(...args);
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  bridge.player = { citizenid: 'CIT_A' };
});

describe('which side each event is registered on', () => {
  it('sendNewMail is a net event, because it only ever mails the source', () => {
    expect(netHandlers.has(QB_PHONE_SERVER_EVENTS.sendNewMail)).toBe(true);
    expect(localHandlers.has(QB_PHONE_SERVER_EVENTS.sendNewMail)).toBe(false);
  });

  it('sendNewMailToOffline is local only, because it names a citizenid', () => {
    // qb-phone registered it as a net event, which let any client mail anybody. Not here.
    expect(localHandlers.has(QB_PHONE_SERVER_EVENTS.sendNewMailToOffline)).toBe(true);
    expect(netHandlers.has(QB_PHONE_SERVER_EVENTS.sendNewMailToOffline)).toBe(false);
  });
});

describe('qbMailFrom', () => {
  it("maps qb's shape onto SendSystemEmail's", () => {
    expect(qbMailFrom(qbMail)).toEqual({
      sender: 'Los Santos Customs',
      subject: 'Your car',
      content: 'It is ready.'
    });
  });

  it('accepts a body already named content, and cuts every field to its column', () => {
    const mapped = qbMailFrom({ sender: 's'.repeat(300), subject: 'x', content: 'body' });
    expect(mapped?.sender).toHaveLength(100);
    expect(mapped?.content).toBe('body');
  });

  it('refuses anything that is not a mail', () => {
    for (const bad of [
      undefined,
      null,
      'mail',
      42,
      {},
      { sender: 'a' },
      { sender: 'a', subject: 'b' }
    ]) {
      expect(qbMailFrom(bad), String(bad)).toBeNull();
    }
  });
});

describe('qb-phone:server:sendNewMail', () => {
  it('mails the source with the mapped payload', () => {
    fireNet(QB_PHONE_SERVER_EVENTS.sendNewMail, qbMail);
    expect(sendSystemEmail).toHaveBeenCalledWith('CIT_A', {
      sender: 'Los Santos Customs',
      subject: 'Your car',
      content: 'It is ready.'
    });
  });

  it('does nothing for a source with no character, or a payload that is not a mail', () => {
    bridge.player = null;
    fireNet(QB_PHONE_SERVER_EVENTS.sendNewMail, qbMail);
    bridge.player = { citizenid: 'CIT_A' };
    fireNet(QB_PHONE_SERVER_EVENTS.sendNewMail, { subject: 'no sender' });
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('stops answering once the window is spent', () => {
    for (let i = 0; i < 200; i += 1) fireNet(QB_PHONE_SERVER_EVENTS.sendNewMail, qbMail);
    expect(sendSystemEmail.mock.calls.length).toBeLessThan(200);
  });
});

describe('qb-phone:server:sendNewMailToOffline', () => {
  const fire = (...args: unknown[]) =>
    localHandlers.get(QB_PHONE_SERVER_EVENTS.sendNewMailToOffline)!(...args);

  it('mails the named citizen', () => {
    fire(' CIT_B ', qbMail);
    expect(sendSystemEmail).toHaveBeenCalledWith(
      'CIT_B',
      expect.objectContaining({ subject: 'Your car' })
    );
  });

  it('refuses a citizenid that is not one, and a payload that is not a mail', () => {
    fire(42, qbMail);
    fire('', qbMail);
    fire('CIT_B', 'hello');
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });
});
