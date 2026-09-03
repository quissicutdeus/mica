// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const bridge = vi.hoisted(() => ({ loaded: true }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () =>
      bridge.loaded ? { citizenid: 'CID', source: 5, setMeta: () => {} } : undefined,
    getAllPlayers: () => ({}),
    getSourceByCitizenId: () => undefined,
    // `phone:start` resolves the caller's own number before it does anything else, so a
    // bridge without this throws on the first call and the loop never reaches the limit.
    getPlayerPhone: () => '555-0000',
    getPlayerByPhone: () => undefined,
    // An unreachable number is still logged as an outgoing call (MICA-95), and that
    // needs the caller's citizenid — same reason as `getPlayerPhone` above.
    getCitizenId: () => (bridge.loaded ? 'CID' : null),
    registerUsableItem: () => {}
  }
}));

import '../services/Accounts';
import '../services/Notifications';
import '../services/BlabberDms';
import '../services/Battery';
import '../services/Phone';
import '../services/Signal';
import '../services/Mail';
/**
 * And then every other service, for the contract check at the bottom of this file.
 *
 * The seven above are named individually because the assertions in the first half are about
 * them specifically and reading them as a list is the point. This one is the whole surface:
 * "which actions are reachable" cannot be answered from a subset, and a contract entry nobody
 * registers is only visible once everything has registered.
 */
import '../services';
import { __resetRateLimits } from '../lib/rateLimit';
import { registeredCustomActions } from '../lib/services';
import { actionsOf, allContracts, contractFor } from '@gos/shared/contract';

/**
 * What a client can reach, and why the route table was never the answer.
 *
 * A registered net event is reachable. Not "reachable if a NUI route points at it" — a
 * modified client emits `gos:server:<service>:<action>` directly and never touches the
 * NUI bridge at all. `shared/routes.ts` only ever bounded CEF XSS, which is confined to
 * registered NUI callbacks (§7).
 *
 * That distinction was easy to miss while every reachable action happened to have a route.
 * The generic service route made it visible by decoupling the two, and this file is what
 * keeps the reachable set deliberate now that "the UI does not call it" has been shown not
 * to be a control.
 */
beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  dbMock.query.mockResolvedValue([]);
  (globalThis as any).emitNet = vi.fn();
  (globalThis as any).GetConvar = (_n: string, f: string) => f;
  (globalThis as any).GetConvarInt = (_n: string, f: number) => f;
  bridge.loaded = true;
});

describe('nothing registers an action the app does not use', () => {
  /**
   * Each of these was registered, unrouted, and called by nothing. Reachable regardless,
   * which is the point.
   */
  it.each([
    ['gos:server:accounts:delete', 'deleting an account orphans its Blabs and follows'],
    ['gos:server:battery:save', 'the client no longer owns its own charge'],
    ['gos:server:signal:rules', 'the client no longer holds the zone list'],
    ['gos:server:notifications:get', 'the shade reads through getShadeNotifications'],
    ['gos:server:notifications:delete', 'clearing is a soft delete onto cleared_at'],
    ['gos:server:blabber_dms:delete', 'a sent DM is not deletable']
  ])('%s is not registered — %s', (event) => {
    expect(handlers.has(event)).toBe(false);
  });

  it('still registers the actions the app really uses', () => {
    // The guard against over-correcting: disabling one action too many would break a
    // feature silently, since a missing handler is indistinguishable from a slow one until
    // the 15-second timeout.
    for (const event of [
      'gos:server:accounts:update',
      'gos:server:notifications:markAsRead',
      'gos:server:blabber_dms:send'
    ]) {
      expect(handlers.has(event), event).toBe(true);
    }
  });
});

describe('mail is receive-only (MICA-58)', () => {
  /**
   * The decision, in the only form that survives.
   *
   * `access: { write: 'server' }` closes the *generic* create and update path, and
   * `defineService.test.ts` already proves that rule holds for any server-authored
   * service. What it cannot see is a hand-written `registerEvent('sendMail', …)` added
   * to `services/Mail.ts` later — a custom action bypasses the access axis entirely and
   * is reachable the moment it is registered, whether or not the app grows a compose
   * button (§2.9).
   *
   * So the reachable mail surface is pinned as a closed set rather than as an absence.
   * Composing or replying is a product decision with a schema change behind it — mail
   * rows carry a `sender` display string and no sender identity, so there is nothing to
   * address a reply to — and this failing is the intended way to force that decision
   * back into the open.
   */
  // All four are custom: `options: { disableGet, disableDelete }` closes the generic
  // read and delete too, because the list needs an explicit ORDER BY and the deletes
  // carry their own audit entries.
  const MAIL_ACTIONS = ['getMail', 'markAsRead', 'archiveMail', 'deleteMail'];

  it('registers nothing on mail but reading and filing', () => {
    const registered = [...handlers.keys()]
      .filter((event) => event.startsWith('gos:server:mail:'))
      .map((event) => event.slice('gos:server:mail:'.length))
      .toSorted();

    expect(registered).toEqual(MAIL_ACTIONS.toSorted());
  });

  it.each([
    ['gos:server:mail:create', 'nobody writes mail from their own phone'],
    ['gos:server:mail:update', 'a delivered mail is not editable by its recipient'],
    ['gos:server:mail:send', 'there is no player-to-player mail'],
    ['gos:server:mail:reply', 'a system sender has no address to reply to']
  ])('%s is not registered — %s', (event) => {
    expect(handlers.has(event)).toBe(false);
  });
});

describe('raw onNet handlers are rate limited', () => {
  /**
   * These sit outside `ServiceEndpoint`, so they never passed through the limiter every
   * other action gets. A modified client could drive any of them in a loop.
   */
  const drive = (event: string, times: number, arg?: unknown) => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`no handler for ${event}`);
    (globalThis as any).source = 9;
    for (let i = 0; i < times; i++) handler(arg);
  };

  it.each([['gos:server:phone:start', '555-0100']])(
    '%s stops answering once the window is spent',
    (event, arg) => {
      // The default budget is 60 per minute; 200 calls is well past it. What matters is that
      // the handler stops doing work, not the exact number.
      (globalThis as any).emitNet = vi.fn();
      drive(event, 200, arg);

      const calls = (globalThis.emitNet as any).mock.calls.length + dbMock.query.mock.calls.length;
      expect(calls).toBeLessThan(200);
    }
  );

  it('lets an ordinary number of calls through', async () => {
    (globalThis as any).emitNet = vi.fn();
    drive('gos:server:battery:load', 3);

    // `battery:load` reads the saved charge before it pushes, so the emit lands a
    // microtask later. Asserting synchronously would pass against a limiter that refused
    // everything, which is the opposite of what this checks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((globalThis.emitNet as any).mock.calls.length).toBeGreaterThan(0);
  });
});

describe('raw onNet handlers authenticate', () => {
  /**
   * Rate limiting was only half of it.
   *
   * `ServiceEndpoint` refuses a source with no loaded character; these handlers did not
   * check at all. A source that has connected but not picked a character can still emit
   * events, and some of these would have acted on it — `battery:save` writing against a
   * citizenid that does not exist yet.
   */
  const call = (event: string, arg?: unknown) => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`no handler for ${event}`);
    (globalThis as any).source = 11;
    handler(arg);
  };

  it.each([
    ['gos:server:battery:load', undefined],
    ['gos:server:phone:answer', undefined]
  ])('%s does nothing for a source with no character', (event, arg) => {
    bridge.loaded = false;
    (globalThis as any).emitNet = vi.fn();

    call(event, arg);

    expect((globalThis.emitNet as any).mock.calls).toHaveLength(0);
    expect(dbMock.query).not.toHaveBeenCalled();
  });
});

describe('raw onNet handlers validate their payload', () => {
  const call = (event: string, arg: unknown) => {
    (globalThis as any).source = 12;
    handlers.get(event)!(arg);
  };

  it('refuses a target number that is not a bounded string', () => {
    // It reaches `FrameworkBridge.getPlayerByPhone`, which belongs to the framework. Not
    // injection — an unbounded or wrongly-typed value reaching somebody else's lookup.
    (globalThis as any).emitNet = vi.fn();
    for (const bad of [undefined, 42, {}, '   ', 'x'.repeat(200)]) {
      call('gos:server:phone:start', bad);
    }
    expect((globalThis.emitNet as any).mock.calls).toHaveLength(0);
  });
});

describe('the server owns the battery', () => {
  /**
   * The charge used to be the client's: it ran the drain timer and reported over
   * `gos:server:battery:save`, so a modified client asserted whatever number it liked.
   * Validating that payload never changed what it was — the event is gone, and these
   * assertions are what say so.
   */
  it('ticks the charge down without the client saying anything', async () => {
    const battery = await import('../services/Battery');
    battery.__resetBatteryState();
    battery.applyCharge(7, 50);

    // A whole minute of ticks at the module's own cadence. Nothing from any client.
    for (let i = 0; i < 12; i++) battery.__tickBattery();

    expect(battery.currentCharge(7)).toBeLessThan(50);
  });

  it('pushes only when the whole percent moves', async () => {
    const battery = await import('../services/Battery');
    battery.__resetBatteryState();
    battery.applyCharge(8, 80);
    (globalThis as any).emitNet = vi.fn();

    // One tick is a twelfth of a percent, so the phone has nothing new to draw. Pushing
    // every tick would put a message on the wire every five seconds, per player, forever.
    battery.__tickBattery();
    expect((globalThis.emitNet as any).mock.calls).toHaveLength(0);
  });

  it('charges upward, and faster than it drains', async () => {
    const battery = await import('../services/Battery');
    battery.__resetBatteryState();
    battery.applyCharge(9, 50);
    battery.setCharging(9, true);

    for (let i = 0; i < 12; i++) battery.__tickBattery();

    expect(battery.currentCharge(9)).toBeGreaterThan(50);
  });
});

/**
 * The reachable surface, checked in both directions.
 *
 * A contract is only worth anything if the two lists it sits between agree. Each direction
 * catches a different mistake, and neither catches the other's:
 *
 * - **Registered but not declared** is an action with no rule about its payload — the state
 *   this ticket found ninety-seven times. `ServiceEndpoint.registerEvent` throws at startup
 *   for a service that has a contract, so this direction is mostly belt-and-braces there; it
 *   is the check that matters for a service that has not declared one at all.
 * - **Declared but not registered** is the more interesting half. It is an action the web can
 *   see in the contract and generate a typed call for, which the server will never answer — a
 *   15-second timeout with no error, which is the exact failure mode `shared/routes.ts`
 *   exists to prevent on the other layer.
 */
describe('the contract and the registered surface agree', () => {
  const registered = new Set(registeredCustomActions());

  it('declares nothing the server does not answer', () => {
    const orphaned: string[] = [];
    for (const contract of allContracts()) {
      for (const action of actionsOf(contract)) {
        if (!registered.has(`${contract.id}:${action}`)) orphaned.push(`${contract.id}:${action}`);
      }
    }

    expect(orphaned).toEqual([]);
  });

  it('answers nothing that is not declared, by any service', () => {
    /**
     * `registerEvent` throws at startup both for a service with no contract at all and for one
     * whose contract does not name the action — so reaching this assertion means every service
     * loaded cleanly, which is most of the proof. Pinned anyway, and not as belt-and-braces:
     * the throw lives inside one method and this is the statement of the rule, which is what a
     * reader looking for "must every action be declared?" will find.
     */
    const undeclared = [...registered].filter((entry) => {
      const [service, action] = entry.split(':');
      const contract = contractFor(service ?? '');
      return !contract || !(action! in contract.actions);
    });

    expect(undeclared).toEqual([]);
  });

  it('has a custom surface at all, so neither direction is vacuous', () => {
    // Both checks above pass trivially against an empty set. This is what says the module graph
    // really did load every service, which is the thing that makes them mean something.
    expect(registered.size).toBeGreaterThan(80);
    expect(allContracts().length).toBeGreaterThan(15);
  });
});
