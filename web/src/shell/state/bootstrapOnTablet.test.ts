// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// In-process facets, because a unit test stands in for the shell (`bootstrap.test.ts`).
import '../../host/registerFacets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import { ROUTES } from '@mica/shared/routes';
import { registerNuiTransport } from '../../../../sdk/nui/transport';
import { fetchNui } from '../../nui/fetchNui';
import { bootstrapStores, resetBootstrapState } from './bootstrap';
import { setActiveDevice } from './device';

/**
 * Every request the bootstrap makes, from both doors: the shell's own `fetchNui`, mocked here,
 * and the SDK seam an app's `createCrudStore` preload goes through, pointed at the same mock.
 * Nothing is spied away — every real preload runs — so a request this file does not know
 * about is still recorded.
 */
vi.mock('../../nui/fetchNui', () => ({
  fetchNui: vi.fn(() => Promise.resolve([]))
}));
registerNuiTransport((...args) => fetchNui(...args));

/**
 * The services the server answers a tablet for (MICA-264); it refuses every other one. Not
 * read from the server's declarations, which this project cannot import — restated, so a
 * service added to the tablet on one side is a deliberate change to this list too.
 */
const TABLET_SERVICES = [
  'shell',
  'settings',
  'notes',
  'lockscreen',
  'store',
  'admin',
  // The Admin app's queue, on the tablet since MICA-264 put Admin there.
  'reports',
  'mail'
];

const sent = () => vi.mocked(fetchNui).mock.calls.map(([event, data]) => ({ event, data }));

/**
 * The service every request reaches on the server: a generic one names it, and a named route
 * is relayed by the client to the service its `shared/routes.ts` row says — stamped with the
 * open device, so it is refused from a tablet just the same. A client-only action (the
 * citizen id, the balance) reaches no service and is left out.
 */
const servicesReached = () =>
  sent().flatMap(({ event, data }) => {
    if (event === GENERIC_SERVICE_ACTION) return [(data as { service: string }).service];
    const route = ROUTES.find((r) => r.action === event);
    return route ? [route.service] : [];
  });

beforeEach(() => {
  vi.mocked(fetchNui).mockClear();
  resetBootstrapState();
});
afterEach(() => setActiveDevice('phone'));

describe('a tablet bootstrap (MICA-264)', () => {
  it('sends no request to a service the server refuses a tablet', async () => {
    setActiveDevice('tablet');
    await bootstrapStores(true);

    const services = servicesReached();
    // Something was asked: a silent bootstrap would pass the check below too.
    expect(services).toContain('shell');
    expect(services).toContain('notes');
    expect(services.filter((s) => !TABLET_SERVICES.includes(s))).toEqual([]);
    // The Bank's balance is a client-only read, so it is checked by name.
    expect(sent().map((c) => c.event)).not.toContain('getBankBalance');
  });

  it("still asks the phone's own services on the phone", async () => {
    await bootstrapStores(true);

    const services = servicesReached();
    expect(services).toContain('notifications');
    expect(services).toContain('contacts');
    expect(sent().map((c) => c.event)).toContain('getBankBalance');
  });
});
