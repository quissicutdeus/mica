// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  pendingReports,
  resolvedReports,
  pendingReportCount,
  loadPendingReports,
  loadReportHistory,
  resolveReport,
  reopenReport
} from './reports';
import * as fetchNuiModule from '../nui/fetchNui';

beforeEach(() => {
  vi.restoreAllMocks();
  pendingReports.set([]);
  resolvedReports.set([]);
});

const report = (id: number) => ({ id, resolution: 'pending' }) as never;

/**
 * What each call named, as `<service>:<action>` (MICA-213).
 *
 * Every one of these rides the generic `svc` action now, so the first argument is the same
 * string for all of them and the service and action live in the envelope.
 */
const named = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map(([method, payload]) => {
    const { service, action } = (payload ?? {}) as { service?: string; action?: string };
    return method === 'svc' ? `${service}:${action}` : String(method);
  });

describe('reports store', () => {
  it('counts the queue rather than tracking what has been seen', () => {
    // A report is outstanding until somebody decides about it, so opening Admin must
    // not clear the badge the way opening Mail clears an unread count.
    pendingReports.set([report(1), report(2)]);
    expect(get(pendingReportCount)).toBe(2);

    pendingReports.set([report(1)]);
    expect(get(pendingReportCount)).toBe(1);
  });

  it('shows an empty queue when the server refuses a non-admin', async () => {
    /**
     * The stub answers the default when one was asked for, and refuses otherwise — which is
     * `fetchNui`'s own contract (MICA-213 moved the store's `.catch(() => [])` onto
     * `callOr`'s `defaultValue`, so stubbing `fetchNui` stubs out the thing that applies it).
     * What this still checks is that both reads ask for a default at all: one that did not
     * would reject here and blank the queue with an unhandled rejection instead.
     */
    vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(
      (_event: string, _data?: unknown, options?: { defaultValue?: unknown }) =>
        options && 'defaultValue' in options
          ? Promise.resolve(options.defaultValue as never)
          : Promise.reject(new Error('Not authorised'))
    );

    await loadPendingReports();
    await loadReportHistory();

    expect(get(pendingReports)).toEqual([]);
    expect(get(resolvedReports)).toEqual([]);
  });

  it('ignores a reply that is not a list', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ error: 'nope' });
    await loadPendingReports();
    expect(get(pendingReports)).toEqual([]);
  });

  it('re-reads both lists after a decision, so the badge agrees with the server', async () => {
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');
    spy.mockResolvedValueOnce({}); // resolveReport
    spy.mockResolvedValueOnce([] as never); // getReportQueue
    spy.mockResolvedValueOnce([report(9)] as never); // getReportHistory

    await resolveReport(1, 'moderate');

    expect(named(spy)).toEqual(['reports:resolve', 'reports:queue', 'reports:history']);
    expect(get(pendingReports)).toEqual([]);
    expect(get(resolvedReports)).toHaveLength(1);
  });

  it('raises the error the server gave, rather than reporting a decision it refused', async () => {
    // Rejecting rather than resolving `{ error }`: since MICA-213 the store makes a typed
    // `call` with no default, and turning an error reply into a throw is `fetchNui`'s own
    // job (`fetchNui.test.ts` covers that half). Stubbing `fetchNui` replaces that step, so
    // the stub has to fail the way the real one does.
    vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValue(new Error('Not authorised'));

    await expect(resolveReport(1, 'moderate')).rejects.toThrow('Not authorised');
    await expect(reopenReport(1)).rejects.toThrow('Not authorised');
  });

  it('reopens through the same reload path', async () => {
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');
    spy.mockResolvedValueOnce({});
    spy.mockResolvedValueOnce([report(3)] as never);
    spy.mockResolvedValueOnce([] as never);

    await reopenReport(3);

    expect(named(spy)[0]).toBe('reports:reopen');
    expect(get(pendingReports)).toHaveLength(1);
  });
});
