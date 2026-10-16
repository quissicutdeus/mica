// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { invoices, invoicesLoaded, fetchInvoices } from './bank';
import * as fetchNuiModule from '../nui/fetchNui';

/**
 * A refused request, answered the way the real `fetchNui` answers one: the default when the
 * caller asked for one, a throw when it did not. A bare `mockRejectedValue` would skip the
 * defaulting entirely and pass against the very code this file exists to catch.
 */
function refuse<T>(_event: string, _data?: unknown, options?: { defaultValue?: T }): Promise<T> {
  return options?.defaultValue !== undefined
    ? Promise.resolve(options.defaultValue)
    : Promise.reject(new Error('Player not authenticated'));
}

const invoice = (id: number) => ({ id, amount: 100 }) as never;

beforeEach(() => {
  vi.restoreAllMocks();
  invoices.set([]);
  invoicesLoaded.set(false);
});

describe('invoices', () => {
  it('takes the server answer and marks it loaded', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue([invoice(1)]);

    await fetchInvoices();

    expect(get(invoices)).toEqual([invoice(1)]);
    expect(get(invoicesLoaded)).toBe(true);
  });

  it('leaves them unloaded when the first read fails, rather than "no open invoices"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(refuse);

    await fetchInvoices();

    expect(get(invoicesLoaded)).toBe(false);
  });

  it('keeps the last list when a later read fails', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValueOnce([invoice(1)]);
    await fetchInvoices();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(refuse);

    await fetchInvoices();

    expect(get(invoices)).toEqual([invoice(1)]);
    expect(get(invoicesLoaded)).toBe(true);
  });

  it('reads a reply that is not a list as a failure, not as no invoices', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ error: undefined });

    await fetchInvoices();

    expect(get(invoicesLoaded)).toBe(false);
  });
});
