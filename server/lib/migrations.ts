/**
 * Versioned, forward-only schema migrations for changes `SchemaMigrator`'s additive planner
 * cannot safely infer — a rename, a retype, a drop. See AGENTS.md §8, "Schema changes", for
 * the full design.
 *
 * Two paths, and the split between them is the important part: `runPendingMigrations` is the
 * only one allowed to touch the database's shape — it creates the ledger and applies what is
 * missing — while `reportPendingMigrations` reads and never writes, matching the same
 * property `SchemaMigrator.report()` holds. Boot calls the second one.
 */

import { Database } from './Database';
import { schemaMigrationsLedgerDdl, SCHEMA_MIGRATIONS_TABLE } from './schemaSql';
import { migrations as migrationsOnDisk } from '../migrations';

export interface Migration {
  id: string;
  description: string;
  up: () => Promise<void>;
}

export interface MigrationRunResult {
  applied: string[];
  failed: { id: string; error: string } | null;
  remaining: string[];
}

/** Pure: sorted, ledger-filtered list of what still needs to run. */
export function pendingMigrations(
  onDisk: readonly Migration[],
  appliedIds: ReadonlySet<string>
): Migration[] {
  return [...onDisk].sort((a, b) => a.id.localeCompare(b.id)).filter((m) => !appliedIds.has(m.id));
}

/**
 * Runs an ordered list, recording each success via `recordApplied`. Stops at the first
 * failure rather than continuing: MySQL DDL auto-commits per statement — it is not
 * transactional — so a statement that already ran cannot be undone, and blindly moving on
 * to the next migration could compound whatever went wrong.
 */
export async function runMigrations(
  pending: readonly Migration[],
  recordApplied: (id: string) => Promise<void>
): Promise<MigrationRunResult> {
  const applied: string[] = [];
  for (let i = 0; i < pending.length; i++) {
    const migration = pending[i];
    try {
      await migration.up();
    } catch (error) {
      return {
        applied,
        failed: {
          id: migration.id,
          error: error instanceof Error ? error.message : String(error)
        },
        remaining: pending.slice(i + 1).map((m) => m.id)
      };
    }

    /**
     * The ledger write is guarded separately from `up()`, and reported differently, because
     * the two failures leave the database in opposite states. A failed `up()` means the
     * migration did not happen and re-running it is the fix. A failed ledger write means it
     * *did* happen and nothing recorded it — so a blind retry runs it a second time, against
     * a table already in its new shape. It is not counted in `applied`, since `applied` means
     * "applied and recorded", and the operator is told which of the two they are looking at.
     */
    try {
      await recordApplied(migration.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        applied,
        failed: {
          id: migration.id,
          error:
            `it ran, but recording it in \`${SCHEMA_MIGRATIONS_TABLE}\` failed: ${detail}. ` +
            'Check that table by hand before retrying — this migration has already been ' +
            'applied, so running it again is not a no-op.'
        },
        remaining: pending.slice(i + 1).map((m) => m.id)
      };
    }
    applied.push(migration.id);
  }
  return { applied, failed: null, remaining: [] };
}

/**
 * The one piece of DDL this resource runs on its own account, and it is reached from the
 * apply path only. `IF NOT EXISTS` is safe here in a way it is not for an app table (§10):
 * this table has exactly one shape and never gains a column, so "already there" really is
 * nothing to do rather than a change silently skipped.
 */
async function ensureMigrationsLedger(): Promise<void> {
  await Database.query(schemaMigrationsLedgerDdl(), []);
}

async function appliedMigrationIds(): Promise<Set<string>> {
  const rows = await Database.query<{ id: string }[]>(
    `SELECT \`id\` FROM \`${SCHEMA_MIGRATIONS_TABLE}\``,
    []
  );
  return new Set((rows ?? []).map((r) => r.id));
}

/**
 * The write path's preamble: create the ledger if it is not there, read it, filter.
 *
 * Creating it belongs here and nowhere else. `apply` is the one command an operator runs
 * deliberately, from the console, having decided the database should change — so it is the
 * one path allowed to bring its own infrastructure into being.
 */
async function loadPendingMigrations(): Promise<Migration[]> {
  await ensureMigrationsLedger();
  const applied = await appliedMigrationIds();
  return pendingMigrations(migrationsOnDisk, applied);
}

/**
 * The read path's variant: reads the ledger, never creates it, and reports `null` rather
 * than throwing when it cannot be read at all.
 *
 * A missing ledger is the expected case here — a server upgrading from a `gphone.sql` older
 * than the ledger has no such table until `apply` runs once. Any failure is treated as
 * "cannot report", rather than sniffing for `ER_NO_SUCH_TABLE`: the caller is advisory-only,
 * so being wrong about which error this is must not cost more than the report itself, and
 * this codebase's one precedent for classifying a driver error matches on message text
 * (Blabber's duplicate-key translation), which is not a thing to lean on at boot. The
 * message is surfaced to the caller's log either way, so nothing is swallowed silently.
 */
async function readPendingMigrations(): Promise<{ pending: Migration[] } | { error: string }> {
  try {
    const applied = await appliedMigrationIds();
    return { pending: pendingMigrations(migrationsOnDisk, applied) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Applies every migration `server/migrations/` has that the ledger does not, in order.
 * Creates the ledger first. Backs `gphoneschema apply`, and nothing else calls it.
 */
export async function runPendingMigrations(): Promise<MigrationRunResult> {
  const pending = await loadPendingMigrations();

  return runMigrations(pending, async (id) => {
    await Database.query(`INSERT INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES (?)`, [id]);
  });
}

/**
 * Boot-time visibility only — reads the ledger if it can, and writes nothing whatever it
 * finds. Backs the `onResourceStart` report.
 *
 * An unreadable ledger is reported only when there is something on disk it could have been
 * hiding. With no migration files, a fresh server has nothing to say about migrations and
 * says nothing — inventing a line about a table it also declines to create would be noise
 * on every boot of every install that is working correctly.
 */
export async function reportPendingMigrations(): Promise<void> {
  const result = await readPendingMigrations();

  if ('error' in result) {
    if (migrationsOnDisk.length === 0) return;
    console.log(
      `[gphone] could not read the migrations ledger (${result.error}) — run ` +
        "'gphoneschema apply' from the server console to create it and apply what is pending."
    );
    return;
  }

  if (result.pending.length === 0) return;
  console.log('[gphone] pending schema migrations:');
  for (const migration of result.pending) {
    console.log(`  ${migration.id}: ${migration.description}`);
  }
  console.log("[gphone] run 'gphoneschema apply' from the server console to apply them.");
}
