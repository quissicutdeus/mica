// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `server/lib/shell.ts` registers its player-loaded listeners at module scope, so the stubs
 * have to be in place before the module is first imported. A dynamic `import()` inside
 * `beforeEach`, after the stubs are installed, is what makes that possible — a static
 * `import` at the top of this file would be hoisted ahead of them and register against
 * `setup.ts`'s plain noops instead. Both `on` and `onNet` feed the same map: `QBCore:Server:
 * OnPlayerLoaded` is registered via `onNet` (qbx_core fires it over the network), and
 * `QBCore:Server:PlayerLoaded` via `on` (vanilla QBCore fires it locally) — tests only care
 * which handler answers to which name, not which native registered it.
 */
const handlers = new Map<string, (player: unknown) => void>();
const captureHandler = (event: string, handler: (player: unknown) => void) => {
  handlers.set(event, handler);
};
globalThis.on = captureHandler as any;
globalThis.onNet = captureHandler as any;

/**
 * `loadedPlayerSource` guards the network listener with `guardNetEvent`, which asks the
 * framework whether the connection has a loaded character. Mocked rather than left to the
 * real bridge, which would find no `qbx_core`/`qb-core` export and refuse everybody.
 */
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: (src: number) => ({ citizenid: `CID${src}`, source: src, setMeta: () => {} }),
    getCitizenId: () => 'CID',
    registerUsableItem: () => {}
  }
}));

/** The connection the network event arrived on. `source` is set by the runtime in game. */
const CONNECTION = 7;

beforeEach(async () => {
  globalThis.emitNet = vi.fn() as any;
  (globalThis as any).source = CONNECTION;
  const { __resetRateLimits } = await import('../lib/rateLimit');
  __resetRateLimits();
  await import('../lib/shell');
});

describe('notifyPlayer', () => {
  it('emits nothing without a message', async () => {
    const { notifyPlayer } = await import('../lib/shell');
    notifyPlayer(7, { message: '' } as any);
    expect(globalThis.emitNet).not.toHaveBeenCalled();
  });

  it('emits a toast to the given source', async () => {
    const { notifyPlayer } = await import('../lib/shell');
    notifyPlayer(7, { type: 'error', message: 'Busy' });
    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:shell:notify', 7, {
      type: 'error',
      message: 'Busy'
    });
  });
});

describe('pushRehydrate', () => {
  it('emits the shell rehydrate event to the given source', async () => {
    const { pushRehydrate } = await import('../lib/shell');
    pushRehydrate(7);
    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:shell:rehydrate', 7);
  });
});

describe('character-loaded listeners', () => {
  it('registers for both QBCore and qbx player-loaded events', () => {
    expect(handlers.has('QBCore:Server:OnPlayerLoaded')).toBe(true);
    expect(handlers.has('QBCore:Server:PlayerLoaded')).toBe(true);
  });

  it('pushes a rehydrate to the connection when qbx_core sends no payload', () => {
    handlers.get('QBCore:Server:OnPlayerLoaded')!(undefined);
    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:shell:rehydrate', CONNECTION);
  });

  it('pushes a rehydrate for a bare numeric payload that agrees with the connection', () => {
    handlers.get('QBCore:Server:OnPlayerLoaded')!(CONNECTION);
    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:shell:rehydrate', CONNECTION);
  });

  it('pushes a rehydrate to the resolved source from a QBCore player object', () => {
    // The local twin, which no client can emit — it keeps reading the payload.
    handlers.get('QBCore:Server:PlayerLoaded')!({ PlayerData: { source: 9 } });
    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:shell:rehydrate', 9);
  });

  it('ignores a network payload naming a third party', () => {
    // MICA-136. `onNet` means any connected client can send this; the id in the payload
    // is theirs to choose and the connection is not.
    handlers.get('QBCore:Server:OnPlayerLoaded')!({ PlayerData: { source: 9 } });
    expect(globalThis.emitNet).not.toHaveBeenCalled();
  });

  it('does nothing when the local twin cannot resolve a source', () => {
    handlers.get('QBCore:Server:PlayerLoaded')!({ PlayerData: {} });
    expect(globalThis.emitNet).not.toHaveBeenCalled();
  });
});
