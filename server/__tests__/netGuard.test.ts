// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MICA-210: every raw `onNet` handler declares its positional input as a tuple schema, and
 * `guardNetEvent` parses it before the handler body runs.
 *
 * `netGuardCensus.test.ts` proves, from the source tree, that every handler *passes* a
 * schema. This file proves the schema does something: for each of the five input shapes the
 * raw handlers take, a malformed argument list is dropped — silently, before the framework
 * is asked who is calling — and a well-formed one reaches the body. The real handlers are
 * driven rather than the schemas checked in isolation, because the declaration and the body
 * reading it are the two halves that can disagree.
 */
const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const bridge = vi.hoisted(() => ({ loaded: true, getPlayer: vi.fn() }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (src: number) => {
      bridge.getPlayer(src);
      return bridge.loaded ? { citizenid: 'CID', source: src, setMeta: () => {} } : null;
    },
    getAllPlayers: () => ({}),
    getSourceByCitizenId: () => undefined,
    getSourcesByCitizenId: () => new Map(),
    getPlayerPhone: () => '555-0000',
    getPlayerByPhone: () => undefined,
    getCitizenId: () => (bridge.loaded ? 'CID' : null),
    registerUsableItem: () => {}
  },
  detectFramework: () => 'qb'
}));
vi.mock('../services/Admin', () => ({ isAdmin: () => true }));
const proximity = vi.hoisted(() => ({ nearby: [{ source: 9, citizenid: 'CID_B' }] }));
vi.mock('../lib/proximity', () => ({
  findNearbyVisiblePlayers: vi.fn(async () => proximity.nearby)
}));

import '../services/Phone';
import '../services/Battery';
import '../services/Contacts';
import '../lib/phoneItem';
import { isPhoneOpen } from '../lib/PhoneOpenState';
import { batteryLevel, guardNetEvent, noInput, phoneNumber } from '../lib/netGuard';
import { __resetRateLimits } from '../lib/rateLimit';
import { s } from '@mica/shared/schema';

const SRC = 12;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  bridge.loaded = true;
  dbMock.query.mockResolvedValue([]);
  dbMock.insert.mockResolvedValue(1);
  dbMock.scalar.mockResolvedValue(null);
  (globalThis as any).emitNet = vi.fn();
  (globalThis as any).source = SRC;
});

/** Emit the event as the runtime would: positional arguments, `source` already set. */
const fire = async (event: string, ...args: unknown[]) => {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler for ${event}`);
  handler(...args);
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const emitted = (event: string) =>
  (globalThis.emitNet as any).mock.calls.filter((call: unknown[]) => call[0] === event);
const anyEmit = () => (globalThis.emitNet as any).mock.calls.length;

describe('guardNetEvent parses the tuple before the handler runs', () => {
  const START = s.tuple([phoneNumber]);

  it('hands the handler the parsed input and the player together', () => {
    const guarded = guardNetEvent('t', 'ok', START, ['  555-0100 ']);

    expect(guarded).not.toBeNull();
    expect(guarded!.input).toEqual(['555-0100']);
    expect(guarded!.player.citizenid).toBe('CID');
  });

  it('refuses a malformed argument list, and does so before asking the framework who is calling', () => {
    // The parse is pure and sits between the rate limit and the player lookup, so a flood
    // of garbage never makes the server walk the player table.
    for (const bad of [[42], [{}], ['   '], ['x'.repeat(33)], [], [undefined], 'not-a-list']) {
      expect(guardNetEvent('t', 'bad', START, bad as unknown[])).toBeNull();
    }
    expect(bridge.getPlayer).not.toHaveBeenCalled();
  });

  it('still refuses a well-formed payload from a source with no loaded character', () => {
    bridge.loaded = false;
    expect(guardNetEvent('t', 'nobody', START, ['555-0100'])).toBeNull();
  });

  it('applies the schema transform, so the body reads a clamped level rather than a raw one', () => {
    const LEVEL = s.tuple([batteryLevel]);
    expect(guardNetEvent('t', 'level', LEVEL, [150])!.input).toEqual([100]);
    expect(guardNetEvent('t', 'level', LEVEL, ['42.4'])!.input).toEqual([42]);
    expect(guardNetEvent('t', 'level', LEVEL, [-3])!.input).toEqual([0]);
  });

  it('noInput takes an empty list or a trailing undefined, and nothing carrying a value', () => {
    // A relay forwarding a no-argument emit as one explicit `undefined` is a shape the
    // runtime produces; an argument with a value is one the handler never declared.
    expect(guardNetEvent('t', 'none', noInput, [])).not.toBeNull();
    expect(guardNetEvent('t', 'none', noInput, [undefined])).not.toBeNull();
    expect(guardNetEvent('t', 'none', noInput, [0])).toBeNull();
    expect(guardNetEvent('t', 'none', noInput, ['', undefined])).toBeNull();
  });
});

describe('phone:start — a phone number', () => {
  const EVENT = 'mica:server:phone:start';

  it('reaches placeCall with a well-formed number', async () => {
    await fire(EVENT, '555-0100');
    // An unreachable number is still answered with a failed event and logged (MICA-95),
    // which is how a call that got as far as the body shows itself.
    expect(anyEmit()).toBeGreaterThan(0);
  });

  it('drops a number that is not a bounded string, without looking the caller up', async () => {
    for (const bad of [undefined, 42, {}, '   ', 'x'.repeat(200), ['555-0100']]) {
      await fire(EVENT, bad);
    }
    await fire(EVENT, '555-0100', 'a second argument');

    expect(anyEmit()).toBe(0);
    expect(bridge.getPlayer).not.toHaveBeenCalled();
  });
});

describe('phone:simulateIncoming — an optional phone number', () => {
  const EVENT = 'mica:server:phone:simulateIncoming';
  const INCOMING = 'mica:client:phone:incoming';

  it('rings from the given number, or the default when none is sent', async () => {
    await fire(EVENT, '555-0177');
    expect(emitted(INCOMING)).toHaveLength(1);

    await fire('mica:server:phone:end');
    await fire(EVENT);
    expect(emitted(INCOMING)).toHaveLength(2);
  });

  it('drops anything that is not a string', async () => {
    for (const bad of [42, {}, ['555-0177'], 'x'.repeat(33)]) await fire(EVENT, bad);
    expect(emitted(INCOMING)).toHaveLength(0);
  });
});

describe('phone:answer, phone:end, battery:load, shell:checkPhoneItem — no input', () => {
  it('battery:load answers an empty emit, and one relayed as a bare undefined', async () => {
    await fire('mica:server:battery:load');
    await fire('mica:server:battery:load', undefined);
    expect(emitted('mica:client:battery:set')).toHaveLength(2);
  });

  it('battery:load drops an emit carrying a value', async () => {
    await fire('mica:server:battery:load', 1);
    await fire('mica:server:battery:load', { level: 1 });
    expect(emitted('mica:client:battery:set')).toHaveLength(0);
    expect(bridge.getPlayer).not.toHaveBeenCalled();
  });

  it('shell:checkPhoneItem counts on an empty emit and not on one carrying a value', async () => {
    await fire('mica:server:shell:checkPhoneItem', 'again');
    expect(emitted('mica:client:shell:phoneItem')).toHaveLength(0);

    await fire('mica:server:shell:checkPhoneItem');
    expect(emitted('mica:client:shell:phoneItem')).toHaveLength(1);
  });

  it('phone:answer and phone:end drop an emit carrying a value before the player lookup', async () => {
    await fire('mica:server:phone:answer', 7);
    await fire('mica:server:phone:end', { callId: 7 });
    expect(bridge.getPlayer).not.toHaveBeenCalled();
  });
});

describe('admin:setBattery — a level', () => {
  const EVENT = 'mica:server:admin:setBattery';
  const SET = 'mica:client:battery:set';

  it('applies a number or a numeric string, clamped to 0-100', async () => {
    await fire(EVENT, 150);
    await fire(EVENT, '42');
    expect(emitted(SET).map((call: unknown[]) => call[2])).toEqual([100, 42]);
  });

  it('drops what was never a level: nothing, blank, null, an object', async () => {
    // `Number(null)` and `Number('')` are both `0`, which is how a client sending nothing
    // used to set a valid "0% battery".
    for (const bad of [undefined, null, '', '  ', 'abc', {}, [50], Number.NaN]) {
      await fire(EVENT, bad);
    }
    expect(emitted(SET)).toHaveLength(0);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

describe('contacts:share — a card', () => {
  const EVENT = 'mica:server:contacts:share';
  const INCOMING = 'mica:client:contacts:incoming';

  it('relays a card, trimmed and clipped, ignoring the columns it does not read', async () => {
    await fire(EVENT, {
      id: 4,
      citizenid: 'CID_SPOOFED',
      firstname: '  Ada ',
      lastname: null,
      phone: '5'.repeat(30),
      avatar: undefined,
      sender: { citizenid: 'CID_SPOOFED' }
    });

    const [push] = emitted(INCOMING);
    expect(push).toBeDefined();
    expect(push[2]).toMatchObject({
      firstname: 'Ada',
      lastname: '',
      phone: '5'.repeat(20),
      avatar: '',
      sender: { citizenid: 'CID' }
    });
  });

  it('drops a card that is not an object, or whose name or phone is missing, blank or not text', async () => {
    for (const bad of [
      undefined,
      'Ada',
      ['Ada', '555-0100'],
      { firstname: 'Ada' },
      { phone: '555-0100' },
      { firstname: '   ', phone: '555-0100' },
      { firstname: 5, phone: '555-0100' },
      { firstname: 'Ada', phone: '555-0100', lastname: 7 }
    ]) {
      await fire(EVENT, bad);
    }
    expect(emitted(INCOMING)).toHaveLength(0);
    expect(bridge.getPlayer).not.toHaveBeenCalled();
  });
});

describe('shell:setOpen — a boolean, or { device, open }', () => {
  const EVENT = 'mica:server:shell:setOpen';

  it('reads both shapes the client has ever sent', async () => {
    await fire(EVENT, true);
    expect(isPhoneOpen(SRC)).toBe(true);
    await fire(EVENT, false);
    expect(isPhoneOpen(SRC)).toBe(false);

    await fire(EVENT, { device: 'tablet', open: true });
    expect(isPhoneOpen(SRC)).toBe(true);
    await fire(EVENT, { device: 'phone' });
    expect(isPhoneOpen(SRC)).toBe(false);
  });

  it('drops anything else, so a malformed push cannot flip the state', async () => {
    await fire(EVENT, true);
    expect(isPhoneOpen(SRC)).toBe(true);

    for (const bad of ['false', 0, null, { open: 'no' }, { open: false, extra: 1 }, [false]]) {
      await fire(EVENT, bad);
    }
    expect(isPhoneOpen(SRC)).toBe(true);
  });
});
