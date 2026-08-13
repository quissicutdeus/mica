/**
 * Versioned, forward-only schema migrations for changes `SchemaMigrator`'s additive planner
 * cannot safely infer — a rename, a retype, a drop. See docs/roadmap.md, "Versioned
 * migrations for breaking schema changes", for the full design.
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
    await recordApplied(migration.id);
    applied.push(migration.id);
  }
  return { applied, failed: null, remaining: [] };
}

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

/** Applies every migration `server/migrations/` has that the ledger does not, in order. */
export async function runPendingMigrations(): Promise<MigrationRunResult> {
  await ensureMigrationsLedger();
  const applied = await appliedMigrationIds();
  const pending = pendingMigrations(migrationsOnDisk, applied);

  return runMigrations(pending, async (id) => {
    await Database.query(`INSERT INTO \`${SCHEMA_MIGRATIONS_TABLE}\` (\`id\`) VALUES (?)`, [id]);
  });
}

/** Boot-time visibility only — never applies anything. Backs the `onResourceStart` report. */
export async function reportPendingMigrations(): Promise<void> {
  await ensureMigrationsLedger();
  const applied = await appliedMigrationIds();
  const pending = pendingMigrations(migrationsOnDisk, applied);

  if (pending.length === 0) return;
  console.log('[gphone] pending schema migrations:');
  for (const migration of pending) {
    console.log(`  ${migration.id}: ${migration.description}`);
  }
  console.log("[gphone] run 'gphoneschema apply' from the server console to apply them.");
}
