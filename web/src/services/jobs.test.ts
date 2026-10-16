// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { jobs, jobsLoaded, fetchJobs } from './jobs';
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

const job = (name: string) => ({ name }) as never;

beforeEach(() => {
  vi.restoreAllMocks();
  jobs.set([]);
  jobsLoaded.set(false);
});

describe('jobs', () => {
  it('takes the server answer and marks it loaded', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue([job('police')]);

    await fetchJobs();

    expect(get(jobs)).toEqual([job('police')]);
    expect(get(jobsLoaded)).toBe(true);
  });

  it('leaves them unloaded when the first read fails, rather than "you hold no jobs"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(refuse);

    await fetchJobs();

    expect(get(jobsLoaded)).toBe(false);
  });

  it('keeps the last list when a later read fails', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValueOnce([job('police')]);
    await fetchJobs();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(refuse);

    await fetchJobs();

    expect(get(jobs)).toEqual([job('police')]);
    expect(get(jobsLoaded)).toBe(true);
  });
});
