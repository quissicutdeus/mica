// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeAll } from 'vitest';

const { dbMock, handlers, replies } = vi.hoisted(() => {
  const registered = new Map<string, Function>();
  const sent: unknown[][] = [];
  (globalThis as any).onNet = (event: string, handler: Function) => {
    registered.set(event, handler);
  };
  (globalThis as any).emitNet = (...args: unknown[]) => {
    sent.push(args);
  };
  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: registered,
    replies: sent
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import '../services';
import { knownServices } from '../lib/services';
import { parseRequestEvent, responseEventFor } from '@mica/shared/rpc';

/**
 * Which services answer the tablet (MICA-264), proved on the wire: every registered
 * `mica:server:*` action of every service is sent a request naming the tablet, and the reply
 * either refuses it as `server.device.unsupported` or does not.
 *
 * The device list is checked before the player lookup, so with no player loaded a service that
 * lists the tablet answers `server.notAuthenticated` (or another refusal further in), and one
 * that does not answers `unsupported` — no fixture needed to tell them apart. A raw guarded
 * event (`shell:checkDeviceItem`) sends no reply on a response event and is not counted.
 *
 * The pin is the decision: what a tablet may reach. Settings, notes and the lock screen have
 * rows of their own per device; mail, the store, admin, the reports its queue reads and the
 * player's own data export and delete are the citizen's from either; the shell boots on
 * whichever device is open. Everything else is the phone's.
 */
const TABLET_SERVICES = [
  'admin',
  'lockscreen',
  'mail',
  'notes',
  'privacy',
  'reports',
  'settings',
  'shell',
  'store'
];

const outcome = new Map<string, Set<'unsupported' | 'answered'>>();

beforeAll(async () => {
  (globalThis as any).source = 5;
  for (const [event, handler] of handlers) {
    const parsed = parseRequestEvent(event);
    if (!parsed) continue;
    replies.length = 0;
    await handler('cb-1', undefined, 'tablet');
    const reply = replies.find(
      ([name]) => name === responseEventFor(parsed.service, parsed.action)
    )?.[3] as { key?: string } | undefined;
    if (!reply) continue;
    const seen = outcome.get(parsed.service) ?? new Set();
    seen.add(reply.key === 'server.device.unsupported' ? 'unsupported' : 'answered');
    outcome.set(parsed.service, seen);
  }
});

describe('which services answer the tablet (MICA-264)', () => {
  it('reaches a reply from every registered service with an endpoint action', () => {
    // These register no action through `ServiceEndpoint`: `phones`, `phonenumbers` and the
    // import ledger have none a client may reach, and `battery` and `signal` answer raw guarded
    // events (`battery:load`) that read no device and are the phone's alone. A service added
    // to either side of this list is a decision about the tablet, made here.
    const noEndpointAction = ['battery', 'importledger', 'phonenumbers', 'phones', 'signal'];
    expect([...outcome.keys()].sort()).toEqual(
      [...new Set(knownServices())].filter((id) => !noEndpointAction.includes(id)).sort()
    );
  });

  it('answers the tablet on exactly the services that list it, on every action', () => {
    const answered = [...outcome]
      .filter(([, seen]) => seen.has('answered'))
      .map(([service]) => service)
      .sort();
    expect(answered).toEqual(TABLET_SERVICES);
    // And never half a service: every action of one agrees.
    for (const [service, seen] of outcome) expect(seen.size, service).toBe(1);
  });

  it('refuses the tablet on the phone-only services, the call log and contacts among them', () => {
    for (const service of ['contacts', 'phonecalllog', 'battery', 'notifications', 'messages']) {
      if (!outcome.has(service)) continue;
      expect([...outcome.get(service)!], service).toEqual(['unsupported']);
    }
    expect(outcome.get('contacts')).toEqual(new Set(['unsupported']));
  });
});
