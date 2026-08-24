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

beforeEach(async () => {
  globalThis.emitNet = vi.fn() as any;
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
    expect(globalThis.emitNet).toHaveBeenCalledWith('gphone:client:shell:notify', 7, {
      type: 'error',
      message: 'Busy'
    });
  });
});

describe('pushRehydrate', () => {
  it('emits the shell rehydrate event to the given source', async () => {
    const { pushRehydrate } = await import('../lib/shell');
    pushRehydrate(7);
    expect(globalThis.emitNet).toHaveBeenCalledWith('gphone:client:shell:rehydrate', 7);
  });
});

describe('character-loaded listeners', () => {
  it('registers for both QBCore and qbx player-loaded events', () => {
    expect(handlers.has('QBCore:Server:OnPlayerLoaded')).toBe(true);
    expect(handlers.has('QBCore:Server:PlayerLoaded')).toBe(true);
  });

  it('pushes a rehydrate to a bare numeric source from qbx_core (net, no payload)', () => {
    handlers.get('QBCore:Server:OnPlayerLoaded')!(7);
    expect(globalThis.emitNet).toHaveBeenCalledWith('gphone:client:shell:rehydrate', 7);
  });

  it('pushes a rehydrate to the resolved source from a QBCore player object', () => {
    handlers.get('QBCore:Server:PlayerLoaded')!({ PlayerData: { source: 9 } });
    expect(globalThis.emitNet).toHaveBeenCalledWith('gphone:client:shell:rehydrate', 9);
  });

  it('does nothing when the source cannot be resolved', () => {
    handlers.get('QBCore:Server:OnPlayerLoaded')!({ PlayerData: {} });
    expect(globalThis.emitNet).not.toHaveBeenCalled();
  });
});
