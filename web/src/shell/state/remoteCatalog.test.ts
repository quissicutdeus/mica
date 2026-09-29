// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';

/**
 * The transport is what stands in for the server here, one level below `fetchNui`, so the
 * real `callOr` and `fetchNui` run: a rejected send and an error reply are what turn into
 * `unavailable`, and this proves it rather than assuming it.
 */
const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../nui/transport', () => ({ getTransport: () => transport }));

import { fetchRemoteCatalog } from './remoteCatalog';
import type { CatalogEntry } from '../../../../sdk/catalog';

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 'remote_weather',
  name: 'Weather',
  version: '2.0.0',
  description: 'Live weather.',
  bundleUrl: 'https://store.example.com/apps/weather.js',
  sha256: 'b'.repeat(64),
  color: 'bg-blue-500',
  permissions: [],
  ...over
});

describe('fetchRemoteCatalog', () => {
  beforeEach(() => {
    transport.send.mockReset();
    vi.restoreAllMocks();
  });

  it('asks the server for the store service, catalog action, and nothing else', async () => {
    transport.send.mockResolvedValue({ status: 'off' });

    await fetchRemoteCatalog();

    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledWith(GENERIC_SERVICE_ACTION, {
      service: 'store',
      action: 'catalog',
      data: undefined
    });
  });

  it('returns the entries when the server has a catalog', async () => {
    transport.send.mockResolvedValue({ status: 'ok', entries: [entry()] });

    await expect(fetchRemoteCatalog()).resolves.toEqual({ status: 'ok', entries: [entry()] });
  });

  it('returns an empty ok as empty, not as unavailable', async () => {
    transport.send.mockResolvedValue({ status: 'ok', entries: [] });

    await expect(fetchRemoteCatalog()).resolves.toEqual({ status: 'ok', entries: [] });
  });

  it('reports off when the operator disabled remote add-ons', async () => {
    transport.send.mockResolvedValue({ status: 'off' });

    await expect(fetchRemoteCatalog()).resolves.toEqual({ status: 'off' });
  });

  it('reports unavailable when the server could not fetch a catalog', async () => {
    transport.send.mockResolvedValue({ status: 'unavailable' });

    await expect(fetchRemoteCatalog()).resolves.toEqual({ status: 'unavailable' });
  });

  it('drops an invalid row and keeps the valid ones, saying so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { id: 'broken', name: 'No hash' };
    transport.send.mockResolvedValue({
      status: 'ok',
      entries: [broken, entry(), 'not even an object', entry({ color: 'no-bg-class' })]
    });

    await expect(fetchRemoteCatalog()).resolves.toEqual({ status: 'ok', entries: [entry()] });

    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed entry'), broken);
  });

  it('reports unavailable when the transport fails, without throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport.send.mockRejectedValue(new Error('timed out'));

    await expect(fetchRemoteCatalog()).resolves.toEqual({ status: 'unavailable' });
  });

  it('reports unavailable when the server answers with an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport.send.mockResolvedValue({ error: 'Player not authenticated' });

    await expect(fetchRemoteCatalog()).resolves.toEqual({ status: 'unavailable' });
  });

  it.each([
    ['nothing', null],
    ['a bare array', [entry()]],
    ['an unknown status', { status: 'maybe' }],
    ['ok with no entries', { status: 'ok' }],
    ['ok with entries that are not a list', { status: 'ok', entries: 'nope' }]
  ])('reports unavailable for a reply that is %s', async (_label, reply) => {
    transport.send.mockResolvedValue(reply);

    await expect(fetchRemoteCatalog()).resolves.toEqual({ status: 'unavailable' });
  });

  it('shares one call between two askers in the same tick, then asks again next time', async () => {
    transport.send.mockResolvedValue({ status: 'ok', entries: [entry()] });

    const [a, b] = await Promise.all([fetchRemoteCatalog(), fetchRemoteCatalog()]);
    expect(a).toEqual(b);
    expect(transport.send).toHaveBeenCalledTimes(1);

    await fetchRemoteCatalog();
    expect(transport.send).toHaveBeenCalledTimes(2);
  });
});
