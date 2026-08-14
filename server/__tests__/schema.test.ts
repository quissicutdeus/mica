import { describe, it, expect, vi, beforeEach } from 'vitest';

// `Schema.ts` registers its command handler via `RegisterCommand` at import time, so
// capturing it needs a `RegisterCommand` override in place *before* that import runs —
// `vi.hoisted` is what makes this run ahead of the imports below, same reason the mocks do.
const {
  dbMock,
  runPendingMigrationsMock,
  reportPendingMigrationsMock,
  notifyPlayerMock,
  registeredCommands
} = vi.hoisted(() => {
  const registeredCommands = new Map<string, (source: number, args?: string[]) => void>();
  (globalThis as Record<string, unknown>).RegisterCommand = (
    name: string,
    handler: (source: number, args?: string[]) => void
  ) => registeredCommands.set(name, handler);

  return {
    dbMock: {
      query: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      scalar: vi.fn(),
      single: vi.fn()
    },
    runPendingMigrationsMock: vi.fn(),
    reportPendingMigrationsMock: vi.fn(),
    notifyPlayerMock: vi.fn(),
    registeredCommands
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/migrations', () => ({
  runPendingMigrations: runPendingMigrationsMock,
  reportPendingMigrations: reportPendingMigrationsMock
}));
vi.mock('../lib/shell', () => ({ notifyPlayer: notifyPlayerMock }));

import { runApply } from '../services/Schema';
import { SchemaMigrator, type AdditiveApplyResult } from '../lib/SchemaMigrator';

/** `apply()` finding nothing to do. */
const noAdditive = (): AdditiveApplyResult => ({ applied: [], failed: null, remaining: [] });

describe('runApply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runPendingMigrationsMock.mockResolvedValue({ applied: [], failed: null, remaining: [] });
  });

  it('refuses to run from anywhere but the server console', async () => {
    const applySpy = vi.spyOn(SchemaMigrator, 'apply');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(7);

    expect(applySpy).not.toHaveBeenCalled();
    expect(runPendingMigrationsMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[gphoneschema] apply only runs from the server console.');
  });

  it('applies additive changes and logs each one, from the console', async () => {
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce({
      applied: ['add column gphone_widgets.body'],
      failed: null,
      remaining: []
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(0);

    expect(logSpy).toHaveBeenCalledWith('[gphone] add column gphone_widgets.body');
  });

  it('applies pending migrations and logs each id', async () => {
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce(noAdditive());
    runPendingMigrationsMock.mockResolvedValueOnce({
      applied: ['0001_a', '0002_b'],
      failed: null,
      remaining: []
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(0);

    expect(logSpy).toHaveBeenCalledWith('[gphone] applied migration 0001_a');
    expect(logSpy).toHaveBeenCalledWith('[gphone] applied migration 0002_b');
  });

  /**
   * The order is the whole safety property, not a preference. A migration renaming a column
   * describes the shape the declaration *already* claims, so an additive pass that runs
   * first adds the new name as an empty column and the rename then dies on a duplicate,
   * with the data stranded under the old name.
   */
  it('runs pending migrations before the additive pass', async () => {
    const order: string[] = [];
    runPendingMigrationsMock.mockImplementationOnce(async () => {
      order.push('migrations');
      return { applied: [], failed: null, remaining: [] };
    });
    vi.spyOn(SchemaMigrator, 'apply').mockImplementationOnce(async () => {
      order.push('additive');
      return noAdditive();
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(0);

    expect(order).toEqual(['migrations', 'additive']);
  });

  it('reports up to date when nothing changed', async () => {
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce(noAdditive());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(0);

    expect(logSpy).toHaveBeenCalledWith('[gphone] schema is already up to date.');
  });

  it('reports a migration failure and what was not attempted', async () => {
    const applySpy = vi.spyOn(SchemaMigrator, 'apply');
    runPendingMigrationsMock.mockResolvedValueOnce({
      applied: ['0001_a'],
      failed: { id: '0002_b', error: 'boom' },
      remaining: ['0003_c']
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runApply(0);

    expect(errorSpy).toHaveBeenCalledWith('[gphone] migration 0002_b failed: boom');
    expect(errorSpy).toHaveBeenCalledWith('[gphone] not attempted: 0003_c');
    // A half-migrated table is the one shape the additive planner cannot reason about:
    // it would compare a partly-renamed table against the finished declaration and
    // "helpfully" add the columns the failed migration was mid-way through moving.
    expect(applySpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[gphone] additive changes were not applied — fix the migration first.'
    );
  });

  it('reports the additive statements that ran before one failed', async () => {
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce({
      applied: ['add column gphone_widgets.body'],
      failed: { description: 'add key gphone_widgets.citizenid_title', error: 'boom' },
      remaining: ['add column gphone_notes.pinned']
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runApply(0);

    expect(logSpy).toHaveBeenCalledWith('[gphone] add column gphone_widgets.body');
    expect(errorSpy).toHaveBeenCalledWith(
      '[gphone] add key gphone_widgets.citizenid_title failed: boom'
    );
    expect(errorSpy).toHaveBeenCalledWith('[gphone] not attempted: add column gphone_notes.pinned');
    expect(logSpy).not.toHaveBeenCalledWith('[gphone] schema is already up to date.');
  });
});

describe('the gphoneschema command dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runPendingMigrationsMock.mockResolvedValue({ applied: [], failed: null, remaining: [] });
  });

  // `runApply` itself is not supposed to catch its own errors — that's `SchemaMigrator.apply()`
  // and `runPendingMigrations()`'s callers' job to observe. The `.catch()` lives at the
  // `RegisterCommand('gphoneschema', ...)` call site instead, so this test goes through the
  // actual registered handler rather than calling `runApply` directly — calling `runApply`
  // directly would just reject, which is correct for it and would prove nothing about the
  // dispatch boundary this test exists to cover.
  it('catches a thrown error at the dispatch boundary instead of an unhandled rejection', async () => {
    const handler = registeredCommands.get('gphoneschema');
    expect(handler).toBeDefined();

    const boom = new Error('could not determine the current database');
    vi.spyOn(SchemaMigrator, 'apply').mockRejectedValueOnce(boom);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    handler!(0, ['apply']);

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith('[gphoneschema] apply failed:', boom);
    });
  });

  /**
   * The ace check gates the command, not the report half of it. `IsPlayerAceAllowed` is
   * stubbed false in `setup.ts`, so source 7 here is an ordinary player. Before this,
   * `apply` was dispatched ahead of the check: the player got no toast at all, the refusal
   * landed in the server console instead, and they could type it as often as they liked.
   */
  it('refuses a non-admin before the apply sub-dispatch, with feedback in game', async () => {
    const handler = registeredCommands.get('gphoneschema');
    const applySpy = vi.spyOn(SchemaMigrator, 'apply');
    const reportSpy = vi.spyOn(SchemaMigrator, 'report').mockResolvedValue();

    handler!(7, ['apply']);

    expect(notifyPlayerMock).toHaveBeenCalledWith(7, {
      type: 'error',
      message: 'You do not have permission to use that.'
    });
    expect(applySpy).not.toHaveBeenCalled();
    expect(runPendingMigrationsMock).not.toHaveBeenCalled();
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('still lets the console through the ace check to apply', async () => {
    const handler = registeredCommands.get('gphoneschema');
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce(noAdditive());
    vi.spyOn(console, 'log').mockImplementation(() => {});

    handler!(0, ['apply']);

    await vi.waitFor(() => expect(runPendingMigrationsMock).toHaveBeenCalled());
    expect(notifyPlayerMock).not.toHaveBeenCalled();
  });
});
