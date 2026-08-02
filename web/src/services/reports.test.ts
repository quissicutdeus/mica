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
    vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValue(new Error('Not authorised'));

    await loadPendingReports();
    await loadReportHistory();

    expect(get(pendingReports)).toEqual([]);
    expect(get(resolvedReports)).toEqual([]);
  });

  it('ignores a reply that is not a list', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ error: 'nope' } as never);
    await loadPendingReports();
    expect(get(pendingReports)).toEqual([]);
  });

  it('re-reads both lists after a decision, so the badge agrees with the server', async () => {
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');
    spy.mockResolvedValueOnce({} as never); // resolveReport
    spy.mockResolvedValueOnce([] as never); // getReportQueue
    spy.mockResolvedValueOnce([report(9)] as never); // getReportHistory

    await resolveReport(1, 'moderate');

    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      'resolveReport',
      'getReportQueue',
      'getReportHistory'
    ]);
    expect(get(pendingReports)).toEqual([]);
    expect(get(resolvedReports)).toHaveLength(1);
  });

  it('raises the error the server gave, rather than reporting a decision it refused', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ error: 'Not authorised' } as never);

    await expect(resolveReport(1, 'moderate')).rejects.toThrow('Not authorised');
    await expect(reopenReport(1)).rejects.toThrow('Not authorised');
  });

  it('reopens through the same reload path', async () => {
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui');
    spy.mockResolvedValueOnce({} as never);
    spy.mockResolvedValueOnce([report(3)] as never);
    spy.mockResolvedValueOnce([] as never);

    await reopenReport(3);

    expect(spy.mock.calls[0][0]).toBe('reopenReport');
    expect(get(pendingReports)).toHaveLength(1);
  });
});
