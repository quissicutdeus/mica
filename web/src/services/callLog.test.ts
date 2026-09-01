// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { callLog, loadCallLog } from './callLog';
import * as fetchNuiModule from '../nui/fetchNui';

describe('callLog store', () => {
  beforeEach(() => {
    callLog.set([]);
    vi.restoreAllMocks();
  });

  it('starts empty', () => {
    expect(get(callLog)).toEqual([]);
  });

  it('loadCallLog() populates the store from the getCallLog rows', async () => {
    const rows = [{ id: 1, citizenid: 'CID', kind: 'missed', number: '555-0100', duration: 0 }];
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ rows, nextCursor: null });

    await loadCallLog();

    expect(get(callLog)).toEqual(rows);
  });

  it('loadCallLog() leaves the store empty when the request fails', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ rows: [], nextCursor: null });

    await loadCallLog();

    expect(get(callLog)).toEqual([]);
  });
});
