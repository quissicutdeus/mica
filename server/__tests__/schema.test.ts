// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `Schema.ts` registers its command handler via `RegisterCommand` at import time, so
// capturing it needs a `RegisterCommand` override in place *before* that import runs —
// `vi.hoisted` is what makes this run ahead of the imports below, same reason the mocks do.
const {
  dbMock,
  runPendingMigrationsMock,
  reportPendingMigrationsMock,
  notifyPlayerMock,
  registeredCommands,
  startHandlers
} = vi.hoisted(() => {
  const commands = new Map<string, (source: number, args?: string[]) => void>();
  const starts: ((resource: string) => void)[] = [];
  const previousOn = (globalThis as Record<string, unknown>).on as
    ((event: string, handler: unknown) => void) | undefined;
  (globalThis as Record<string, unknown>).on = (event: string, handler: unknown) => {
    if (event === 'onResourceStart') starts.push(handler as (resource: string) => void);
    previousOn?.(event, handler);
  };
  (globalThis as Record<string, unknown>).RegisterCommand = (
    name: string,
    handler: (source: number, args?: string[]) => void
  ) => commands.set(name, handler);

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
    registeredCommands: commands,
    startHandlers: starts
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
import { __setSchemaReadyForTests } from '../lib/schemaReady';

/** `apply()` finding nothing to do. */
const noAdditive = (): AdditiveApplyResult => ({ applied: [], failed: null, remaining: [] });

describe('runApply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runPendingMigrationsMock.mockResolvedValue({ applied: [], failed: null, remaining: [] });
    // No foreign keys onto players: the standing drop's lookup answers an empty list.
    dbMock.query.mockResolvedValue([]);
  });

  const isKeyLookup = (sql: unknown) =>
    String(sql).includes('information_schema.REFERENTIAL_CONSTRAINTS');

  /**
   * MICA-300, from review. The ledger is not evidence the keys onto `players` are gone: a
   * re-imported `mica.sql` records 0006 as applied over tables that keep them. So apply drops
   * what `information_schema` still shows, first, whatever the migrations say.
   */
  it('drops the keys onto players first, before the migrations, whatever the ledger says', async () => {
    const order: string[] = [];
    dbMock.query.mockImplementation(async (sql: string) => {
      if (isKeyLookup(sql)) {
        order.push('lookup');
        return [{ table: 'mica_notes', name: 'fk_notes_citizenid' }];
      }
      order.push(String(sql));
      return [];
    });
    runPendingMigrationsMock.mockImplementation(async () => {
      order.push('migrations');
      return { applied: [], failed: null, remaining: [] };
    });
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce(noAdditive());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(0);

    expect(order).toEqual([
      'lookup',
      'ALTER TABLE `mica_notes` DROP FOREIGN KEY `fk_notes_citizenid`',
      'migrations'
    ]);
    expect(logSpy).toHaveBeenCalledWith('[mica] dropped 1 foreign key(s) onto players.');
    // Something changed, so it does not claim the schema was already up to date.
    expect(logSpy).not.toHaveBeenCalledWith('[mica] schema is already up to date.');
  });

  it('stops, and applies nothing else, when the keys cannot be checked or dropped', async () => {
    dbMock.query.mockRejectedValue(new Error('denied'));
    const applySpy = vi.spyOn(SchemaMigrator, 'apply');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runApply(0);

    expect(errorSpy).toHaveBeenCalledWith(
      '[mica] could not drop the foreign keys onto players; nothing else was applied:',
      expect.any(Error)
    );
    expect(runPendingMigrationsMock).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('reports keys onto players at every start, from information_schema', async () => {
    dbMock.query.mockResolvedValue([{ table: 'mica_notes', name: 'fk_notes_citizenid' }]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(SchemaMigrator, 'report').mockResolvedValue(undefined);
    reportPendingMigrationsMock.mockResolvedValue(undefined);
    // The reports wait for the first-start schema check (MICA-306): an existing database.
    __setSchemaReadyForTests({ kind: 'existing' });

    for (const start of startHandlers) start('mica');
    await vi.waitFor(() =>
      expect(errorSpy.mock.calls.some((c) => /1 foreign key\(s\)/.test(String(c[0])))).toBe(true)
    );
    expect(dbMock.query.mock.calls.some((c) => isKeyLookup(c[0]))).toBe(true);
  });

  /**
   * MICA-300. `runApply` used to refuse before any DDL when `players.citizenid` was collated
   * differently from micaOS's tables (MICA-157), because the foreign keys onto `players` could
   * not be created across the mismatch. There are no such keys any more — and migration 0006,
   * which drops them, runs inside this very command — so a qb server whose `players` takes
   * MariaDB 11's default collation is applied like any other, with nothing read first.
   */
  it('goes straight to the migrations, asking nothing about players first', async () => {
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce(noAdditive());
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(0);

    expect(runPendingMigrationsMock).toHaveBeenCalledTimes(1);
    // The one read is the standing lookup of keys onto players, above; no collation is asked.
    const reads = dbMock.query.mock.calls.map((c) => String(c[0]));
    expect(reads.every(isKeyLookup)).toBe(true);
    for (const fn of [dbMock.scalar, dbMock.single]) expect(fn).not.toHaveBeenCalled();
  });

  it('refuses to run from anywhere but the server console', async () => {
    const applySpy = vi.spyOn(SchemaMigrator, 'apply');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(7);

    expect(applySpy).not.toHaveBeenCalled();
    expect(runPendingMigrationsMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[micaschema] apply only runs from the server console.');
  });

  it('applies additive changes and logs each one, from the console', async () => {
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce({
      applied: ['add column mica_widgets.body'],
      failed: null,
      remaining: []
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(0);

    expect(logSpy).toHaveBeenCalledWith('[mica] add column mica_widgets.body');
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

    expect(logSpy).toHaveBeenCalledWith('[mica] applied migration 0001_a');
    expect(logSpy).toHaveBeenCalledWith('[mica] applied migration 0002_b');
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

    expect(logSpy).toHaveBeenCalledWith('[mica] schema is already up to date.');
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

    expect(errorSpy).toHaveBeenCalledWith('[mica] migration 0002_b failed: boom');
    expect(errorSpy).toHaveBeenCalledWith('[mica] not attempted: 0003_c');
    // A half-migrated table is the one shape the additive planner cannot reason about:
    // it would compare a partly-renamed table against the finished declaration and
    // "helpfully" add the columns the failed migration was mid-way through moving.
    expect(applySpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[mica] additive changes were not applied — fix the migration first.'
    );
  });

  it('reports the additive statements that ran before one failed', async () => {
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce({
      applied: ['add column mica_widgets.body'],
      failed: { description: 'add key mica_widgets.citizenid_title', error: 'boom' },
      remaining: ['add column mica_notes.pinned']
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runApply(0);

    expect(logSpy).toHaveBeenCalledWith('[mica] add column mica_widgets.body');
    expect(errorSpy).toHaveBeenCalledWith(
      '[mica] add key mica_widgets.citizenid_title failed: boom'
    );
    expect(errorSpy).toHaveBeenCalledWith('[mica] not attempted: add column mica_notes.pinned');
    expect(logSpy).not.toHaveBeenCalledWith('[mica] schema is already up to date.');
  });
});

describe('the micaschema command dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runPendingMigrationsMock.mockResolvedValue({ applied: [], failed: null, remaining: [] });
  });

  // `runApply` itself is not supposed to catch its own errors — that's `SchemaMigrator.apply()`
  // and `runPendingMigrations()`'s callers' job to observe. The `.catch()` lives at the
  // `RegisterCommand('micaschema', ...)` call site instead, so this test goes through the
  // actual registered handler rather than calling `runApply` directly — calling `runApply`
  // directly would just reject, which is correct for it and would prove nothing about the
  // dispatch boundary this test exists to cover.
  it('catches a thrown error at the dispatch boundary instead of an unhandled rejection', async () => {
    const handler = registeredCommands.get('micaschema');
    expect(handler).toBeDefined();

    const boom = new Error('could not determine the current database');
    vi.spyOn(SchemaMigrator, 'apply').mockRejectedValueOnce(boom);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    handler!(0, ['apply']);

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith('[micaschema] apply failed:', boom);
    });
  });

  /**
   * The ace check gates the command, not the report half of it. `IsPlayerAceAllowed` is
   * stubbed false in `setup.ts`, so source 7 here is an ordinary player. Before this,
   * `apply` was dispatched ahead of the check: the player got no toast at all, the refusal
   * landed in the server console instead, and they could type it as often as they liked.
   */
  it('refuses a non-admin before the apply sub-dispatch, with feedback in game', async () => {
    const handler = registeredCommands.get('micaschema');
    const applySpy = vi.spyOn(SchemaMigrator, 'apply');
    const reportSpy = vi.spyOn(SchemaMigrator, 'report').mockResolvedValue();

    handler!(7, ['apply']);

    expect(notifyPlayerMock).toHaveBeenCalledWith(7, {
      type: 'error',
      message: 'You do not have permission to use that.',
      key: 'server.schema.noPermission'
    });
    expect(applySpy).not.toHaveBeenCalled();
    expect(runPendingMigrationsMock).not.toHaveBeenCalled();
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('still lets the console through the ace check to apply', async () => {
    const handler = registeredCommands.get('micaschema');
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce(noAdditive());
    vi.spyOn(console, 'log').mockImplementation(() => {});

    handler!(0, ['apply']);

    await vi.waitFor(() => expect(runPendingMigrationsMock).toHaveBeenCalled());
    expect(notifyPlayerMock).not.toHaveBeenCalled();
  });
});
