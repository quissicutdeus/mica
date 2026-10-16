// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

/**
 * `ownerConfig.ts` is imported by `registry.ts` (module scope), which several other node
 * suites load — a fresh module per test, the same mechanics `capabilities.test.ts` uses,
 * so a mock installed here never leaks into another file's copy.
 *
 * The stub honours `fetchNui`'s one contract that matters here (see its own doc): a
 * failure hands back `options.defaultValue` when one was asked for and throws when not.
 * `refreshOwnerConfig` asks for none and catches itself, so a failure keeps what it held.
 */
const loadOwnerConfig = async (send: () => Promise<unknown>) => {
  vi.resetModules();
  const fetchNui = vi.fn(
    async (_event: string, _data: unknown, options?: { defaultValue?: unknown }) => {
      try {
        return await send();
      } catch (error) {
        if (options && 'defaultValue' in options) return options.defaultValue;
        throw error;
      }
    }
  );
  vi.doMock('../../nui/fetchNui', () => ({ fetchNui }));
  return { ...(await import('./ownerConfig')), fetchNui };
};

beforeEach(() => vi.resetModules());

describe('ownerConfig store', () => {
  it('starts with nothing disabled and the built-in dock', async () => {
    const { ownerConfig, disabledAppIds } = await loadOwnerConfig(async () => ({}));

    expect(get(ownerConfig)).toEqual({
      disabledApps: [],
      defaultDock: [],
      themeSeed: null,
      defaultFrame: 'classic',
      wallpapers: [],
      brandLogo: null,
      sounds: []
    });
    expect(get(disabledAppIds)).toEqual(new Set());
  });

  it('takes the server answer', async () => {
    const { ownerConfig, disabledAppIds, refreshOwnerConfig, fetchNui } = await loadOwnerConfig(
      async () => ({ disabledApps: ['bank'], defaultDock: ['phone', '', '', ''] })
    );
    await refreshOwnerConfig();

    // No default: a failure has to throw, so it can keep what is held instead of
    // writing the defaults over it.
    expect(fetchNui).toHaveBeenCalledWith('svc', {
      service: 'shell',
      action: 'ownerConfig',
      data: undefined
    });
    expect(get(ownerConfig)).toEqual({
      disabledApps: ['bank'],
      defaultDock: ['phone', '', '', '']
    });
    expect(get(disabledAppIds)).toEqual(new Set(['bank']));
  });

  it('leaves the defaults a slow or failed round trip found', async () => {
    const { ownerConfig, refreshOwnerConfig } = await loadOwnerConfig(async () => {
      throw new Error('timeout');
    });
    await refreshOwnerConfig();

    expect(get(ownerConfig)).toEqual({
      disabledApps: [],
      defaultDock: [],
      themeSeed: null,
      defaultFrame: 'classic',
      wallpapers: [],
      brandLogo: null,
      sounds: []
    });
  });

  it('keeps a real answer when a later read fails, rather than re-enabling every app', async () => {
    let fail = false;
    const { ownerConfig, disabledAppIds, refreshOwnerConfig } = await loadOwnerConfig(async () => {
      if (fail) throw new Error('Player not authenticated');
      return { disabledApps: ['bank'], defaultDock: [] };
    });
    await refreshOwnerConfig();

    fail = true;
    await refreshOwnerConfig();

    expect(get(disabledAppIds)).toEqual(new Set(['bank']));
    expect(get(ownerConfig)).toEqual({ disabledApps: ['bank'], defaultDock: [] });
  });
});
