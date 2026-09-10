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
 * `refreshOwnerConfig` leans on `callOr`/the real `fetchNui` to turn a transport failure
 * into `defaultValue` (see `fetchNui.ts`'s own doc) rather than catching itself, the same
 * as `refreshLocale`. The stub below honours that one contract — catch, and hand back
 * `options.defaultValue` — without reimplementing the rest of the real transport.
 */
const loadOwnerConfig = async (send: () => Promise<unknown>) => {
  vi.resetModules();
  const fetchNui = vi.fn(
    async (_event: string, _data: unknown, options?: { defaultValue?: unknown }) => {
      try {
        return await send();
      } catch {
        return options?.defaultValue;
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

    expect(get(ownerConfig)).toEqual({ disabledApps: [], defaultDock: [] });
    expect(get(disabledAppIds)).toEqual(new Set());
  });

  it('takes the server answer', async () => {
    const { ownerConfig, disabledAppIds, refreshOwnerConfig, fetchNui } = await loadOwnerConfig(
      async () => ({ disabledApps: ['bank'], defaultDock: ['phone', '', '', ''] })
    );
    await refreshOwnerConfig();

    expect(fetchNui).toHaveBeenCalledWith(
      'svc',
      { service: 'shell', action: 'ownerConfig', data: undefined },
      expect.objectContaining({ quiet: true })
    );
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

    expect(get(ownerConfig)).toEqual({ disabledApps: [], defaultDock: [] });
  });
});
