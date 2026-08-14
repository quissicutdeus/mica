import { describe, it, expect, vi, beforeEach } from 'vitest';

// `Schema.ts` registers its command handler via `RegisterCommand` at import time, so
// capturing it needs a `RegisterCommand` override in place *before* that import runs —
// `vi.hoisted` is what makes this run ahead of the imports below, same reason the mocks do.
const { dbMock, runPendingMigrationsMock, reportPendingMigrationsMock, registeredCommands } =
  vi.hoisted(() => {
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
      registeredCommands
    };
  });
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/migrations', () => ({
  runPendingMigrations: runPendingMigrationsMock,
  reportPendingMigrations: reportPendingMigrationsMock
}));

import { runApply } from '../services/Schema';
import { SchemaMigrator } from '../lib/SchemaMigrator';

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
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce(['add column gphone_widgets.body']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(0);

    expect(logSpy).toHaveBeenCalledWith('[gphone] add column gphone_widgets.body');
  });

  it('applies pending migrations and logs each id', async () => {
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce([]);
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

  it('reports up to date when nothing changed', async () => {
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApply(0);

    expect(logSpy).toHaveBeenCalledWith('[gphone] schema is already up to date.');
  });

  it('reports a migration failure and what was not attempted', async () => {
    vi.spyOn(SchemaMigrator, 'apply').mockResolvedValueOnce([]);
    runPendingMigrationsMock.mockResolvedValueOnce({
      applied: ['0001_a'],
      failed: { id: '0002_b', error: 'boom' },
      remaining: ['0003_c']
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runApply(0);

    expect(errorSpy).toHaveBeenCalledWith('[gphone] migration 0002_b failed: boom');
    expect(errorSpy).toHaveBeenCalledWith('[gphone] not attempted: 0003_c');
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
});
