// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchNuiMock = vi.hoisted(() => vi.fn());
vi.mock('../nui/fetchNui', () => ({ fetchNui: fetchNuiMock }));

import { submitScore, getLeaderboard } from './highscores';

beforeEach(() => {
  fetchNuiMock.mockReset();
});

describe('submitScore', () => {
  // The typed `call` rides the generic service action, so the transport sees one envelope
  // rather than a named route (MICA-213).
  it('names the highscores contract action and carries the app and score', async () => {
    fetchNuiMock.mockResolvedValue({ ok: true });
    await submitScore('snek', 42);
    expect(fetchNuiMock).toHaveBeenCalledWith('svc', {
      service: 'highscores',
      action: 'submit',
      data: { app: 'snek', score: 42 }
    });
  });

  it('swallows a server error rather than throwing', async () => {
    fetchNuiMock.mockRejectedValue(new Error('offline'));
    await expect(submitScore('snek', 42)).resolves.toBeUndefined();
  });
});

describe('getLeaderboard', () => {
  it('returns the resolved rows', async () => {
    const rows = [{ citizenid: 'A', score: 10, displayName: 'Ada' }];
    fetchNuiMock.mockResolvedValue(rows);
    await expect(getLeaderboard('snek')).resolves.toEqual(rows);
  });

  it('returns an empty list on failure rather than throwing', async () => {
    fetchNuiMock.mockRejectedValue(new Error('offline'));
    await expect(getLeaderboard('snek')).resolves.toEqual([]);
  });
});
