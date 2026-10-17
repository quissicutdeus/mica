// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { declaredServices } from './defineService';
import { ownerTableKnown } from './ownerWidth';
import { AUDIT_LOG_TABLE } from './AuditLogger';
import { orderAppsByDependency } from './schemaSql';
import {
  isNoop,
  planAppMigration,
  planAuditLogMigration,
  planChildMigration,
  type LiveTable,
  type MigrationPlan
} from './migrate';

/**
 * Reconcile the live database with the schema declarations, additively.
 *
 * `report()` runs at resource start; `apply()` runs only from `micaschema apply` at the
 * server console, and after the versioned migrations (AGENTS.md §8). Boot reports rather than
 * applies because the alternative — a resource that reshapes a live database on start — gives
 * an operator no moment at which to take a backup. It still has to say something at boot: an
 * upgraded micaOS whose database is missing a column the code expects otherwise fails later,
 * as a query error in whichever app happened to touch it first.
 *
 * Additive only, and loud. A missing table is created whole (MICA-388); a missing column or
 * index is added. Anything it will not do itself is printed with the exact situation, so the
 * operator can decide. See `migrate.ts` for why drops, renames and
 * type changes are excluded, and `migrations.ts` for the path that does handle them.
 */

const currentDatabase = async (): Promise<string | null> =>
  await Database.scalar<string>('SELECT DATABASE()', []);

/**
 * Read a table's real shape.
 *
 * `information_schema` rather than `SHOW CREATE TABLE` because it returns rows that
 * need no parsing. Scoped to the current schema — without that, a server whose user can
 * see several databases matches same-named tables in all of them.
 */
const readLiveTable = async (schema: string, table: string): Promise<LiveTable> => {
  const columns = await Database.query<
    { COLUMN_NAME: string; COLUMN_TYPE: string; IS_NULLABLE: string }[]
  >(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, table]
  );

  if (!columns || columns.length === 0) {
    return { exists: false, columns: [], indexes: [] };
  }

  const indexes = await Database.query<{ INDEX_NAME: string }[]>(
    `SELECT DISTINCT INDEX_NAME
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, table]
  );

  return {
    exists: true,
    columns: columns.map((c) => ({
      name: c.COLUMN_NAME,
      type: c.COLUMN_TYPE,
      nullable: c.IS_NULLABLE === 'YES'
    })),
    indexes: (indexes ?? []).map((i) => i.INDEX_NAME)
  };
};

/**
 * Every table micaOS owns, primary and child alike, and the audit ledger — **in the order the
 * first-start bootstrap creates them** (`bootstrapTables`): the ledger, which nothing
 * references, then apps in foreign-key order (`orderAppsByDependency`), each primary table
 * before its child tables. `apply()` runs creates in this order, so a new table's foreign key
 * always finds its target, whether that was there already or created a statement earlier.
 * The migrations ledger is not here: `runPendingMigrations` creates it, before this runs.
 */
const collectPlans = async (schema: string): Promise<MigrationPlan[]> => {
  // Which width a citizenid column should have here (MICA-289); null in the boot window.
  const options = { ownerTable: ownerTableKnown() };

  const plans: MigrationPlan[] = [
    planAuditLogMigration(await readLiveTable(schema, AUDIT_LOG_TABLE), options)
  ];

  for (const resolved of orderAppsByDependency(declaredServices)) {
    plans.push(planAppMigration(resolved, await readLiveTable(schema, resolved.table), options));

    for (const child of resolved.childTables) {
      plans.push(planChildMigration(child, await readLiveTable(schema, child.name), options));
    }
  }

  return plans;
};

/**
 * What `apply()` did, and what it did not get to. Mirrors `MigrationRunResult` in
 * `migrations.ts` — `applied` and `remaining` hold statement descriptions, the same lines
 * `report()` prints, because those are what an operator can act on.
 */
export interface AdditiveApplyResult {
  applied: string[];
  failed: { description: string; error: string } | null;
  remaining: string[];
}

const describe = (plan: MigrationPlan): string[] => {
  const lines: string[] = [];
  if (plan.create) lines.push(`  ${plan.create.description} (it does not exist)`);
  for (const statement of plan.additive) lines.push(`  ${statement.description}`);
  for (const issue of plan.drift) lines.push(`  needs a human: ${issue}`);
  return lines;
};

export const SchemaMigrator = {
  /** Plan without touching anything. */
  async plan(): Promise<MigrationPlan[]> {
    const schema = await currentDatabase();
    if (!schema) throw new Error('could not determine the current database');
    return await collectPlans(schema);
  },

  /** Print what would change. Backs the `micaschema` command. */
  async report(): Promise<void> {
    let plans: MigrationPlan[];
    try {
      plans = await SchemaMigrator.plan();
    } catch (e) {
      console.error('[mica] schema check failed:', e);
      return;
    }

    const interesting = plans.filter((p) => !isNoop(p));
    if (interesting.length === 0) {
      console.log('[mica] schema is up to date.');
      return;
    }

    console.log('[mica] schema differences:');
    for (const plan of interesting) {
      for (const line of describe(plan)) console.log(line);
    }
    if (interesting.some((p) => p.create || p.additive.length > 0)) {
      console.log(
        "[mica] run 'micaschema apply' from the server console to create and add what is " +
          'listed above, after taking a backup.'
      );
    }
  },

  /**
   * Execute every additive statement `plan()` finds — the missing tables, columns and indexes
   * it is always safe to add. Never touches anything `plan()` reports as `drift`; those need a
   * human, and stay untouched.
   *
   * **Every create first, then every column and index** (MICA-388), creates in `plan()`'s
   * foreign-key order. Each create is `CREATE TABLE IF NOT EXISTS` from the declaration, in its
   * final shape, so a table it creates has no additive statement of its own and a second run
   * finds nothing to do.
   *
   * Reports partial progress rather than throwing it away. MySQL DDL auto-commits per
   * statement, so a failure on the third of five leaves the first two applied and permanent;
   * rejecting the whole call would tell the operator only that something went wrong, in the
   * one command that changes a live database. Same `{ applied, failed, remaining }` shape as
   * `runMigrations` in `migrations.ts`, deliberately: `micaschema apply` runs both halves
   * and should not need two ways to say the same thing. It stops at the first failure for
   * the same reason that runner does — the next statement may depend on the one that did
   * not land.
   *
   * A `plan()` failure still throws: that is a precondition (no database, no
   * `information_schema` read), not partial progress, and nothing has been applied.
   */
  async apply(): Promise<AdditiveApplyResult> {
    const plans = await SchemaMigrator.plan();
    const statements = [
      ...plans.flatMap((plan) => (plan.create ? [plan.create] : [])),
      ...plans.flatMap((plan) => plan.additive)
    ];
    const applied: string[] = [];

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      try {
        await Database.query(statement.sql, []);
      } catch (error) {
        return {
          applied,
          failed: {
            description: statement.description,
            error: error instanceof Error ? error.message : String(error)
          },
          remaining: statements.slice(i + 1).map((s) => s.description)
        };
      }
      applied.push(statement.description);
    }

    return { applied, failed: null, remaining: [] };
  }
};
