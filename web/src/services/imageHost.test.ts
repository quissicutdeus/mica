// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { imageHostOrigin, refreshImageHost } from './imageHost';
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

beforeEach(() => {
  vi.restoreAllMocks();
  imageHostOrigin.set(null);
});

describe('refreshImageHost', () => {
  it('takes a valid origin from the server', async () => {
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ origin: 'https://img.example' });

    await refreshImageHost();

    expect(get(imageHostOrigin)).toBe('https://img.example');
  });

  it('keeps the last origin when a re-read fails, rather than "no image host"', async () => {
    imageHostOrigin.set('https://img.example');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(refuse);

    await refreshImageHost();

    expect(get(imageHostOrigin)).toBe('https://img.example');
  });
});
