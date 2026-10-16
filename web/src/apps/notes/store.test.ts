// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const service = vi.hoisted(() => ({ call: vi.fn() }));

/**
 * The SDK stubbed to the three things this store takes from it. `useService`'s `call` is
 * the seam under test; the CRUD factory is not, so it is a bare object.
 */
vi.mock('@mica/sdk', () => ({
  useService: () => ({ call: service.call }),
  createCrudStore: () => ({ load: vi.fn() }),
  byNewest: () => () => 0
}));

import { useNotes } from './store';

/**
 * A refused request, answered the way `useService(id).call` answers one: the default when
 * the caller passed one, a throw when it did not. A bare rejection would skip the defaulting
 * and pass against the read this pins (MICA-384).
 */
const refuse = (_action: string, _data?: unknown, defaultValue?: unknown) =>
  defaultValue !== undefined
    ? Promise.resolve(defaultValue)
    : Promise.reject(new Error('Player not authenticated'));

beforeEach(() => {
  service.call.mockReset();
});

describe('getDeletedNotes', () => {
  it('takes the server list', async () => {
    const rows = [{ id: 3, title: 'gone' }];
    service.call.mockResolvedValue(rows);

    await expect(useNotes().getDeletedNotes()).resolves.toEqual(rows);
    expect(service.call).toHaveBeenCalledWith('getDeleted', {});
  });

  it('rejects on a refused request rather than answering "nothing to restore"', async () => {
    service.call.mockImplementation(refuse);
    await expect(useNotes().getDeletedNotes()).rejects.toThrow();
  });

  it('rejects a reply that is not a list', async () => {
    service.call.mockResolvedValue(null);
    await expect(useNotes().getDeletedNotes()).rejects.toThrow();
  });
});
