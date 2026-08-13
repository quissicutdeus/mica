import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `server/lib/shell.ts` registers its `on('QBCore:Server:OnPlayerLoaded', ...)` listeners
 * at module scope, so the stub has to be in place before the module is first imported.
 * A dynamic `import()` inside `beforeEach`, after the stub is installed, is what makes
 * that possible — a static `import` at the top of this file would be hoisted ahead of the
 * stub and register against `setup.ts`'s plain noop instead.
 */
const handlers = new Map<string, (player: unknown) => void>();
globalThis.on = ((event: string, handler: (player: unknown) => void) => {
  handlers.set(event, handler);
}) as any;

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
    expect(handlers.has('qbx_core:server:playerLoaded')).toBe(true);
  });

  it('pushes a rehydrate to a bare numeric source from QBCore', () => {
    handlers.get('QBCore:Server:OnPlayerLoaded')!(7);
    expect(globalThis.emitNet).toHaveBeenCalledWith('gphone:client:shell:rehydrate', 7);
  });

  it('pushes a rehydrate to the resolved source from a qbx player object', () => {
    handlers.get('qbx_core:server:playerLoaded')!({ PlayerData: { source: 9 } });
    expect(globalThis.emitNet).toHaveBeenCalledWith('gphone:client:shell:rehydrate', 9);
  });

  it('does nothing when the source cannot be resolved', () => {
    handlers.get('QBCore:Server:OnPlayerLoaded')!({ PlayerData: {} });
    expect(globalThis.emitNet).not.toHaveBeenCalled();
  });
});
