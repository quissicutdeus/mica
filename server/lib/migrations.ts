/**
 * Versioned, forward-only schema migrations for changes `SchemaMigrator`'s additive planner
 * cannot safely infer — a rename, a retype, a drop. See docs/roadmap.md, "Versioned
 * migrations for breaking schema changes", for the full design.
 */

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
