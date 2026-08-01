import { Database } from './Database';
import { declaredApps } from './defineServerApp';
import {
  isNoop,
  planAppMigration,
  planChildMigration,
  type LiveTable,
  type MigrationPlan
} from './migrate';

/**
 * Reconcile the live database with the schema declarations, additively.
 *
 * Runs at resource start. That is a real decision rather than a convenience: the
 * alternative is that upgrading gPhone leaves a database missing columns the code
 * already expects, and the failure surfaces later as a query error in whichever app
 * happened to touch the new column first.
 *
 * Additive only, and loud. Anything it will not do itself is printed with the exact
 * situation, so the operator can decide. See `migrate.ts` for why drops, renames and
 * type changes are excluded.
 */

const CONVAR = 'gphone_auto_migrate';

/** Off with `setr gphone_auto_migrate false`. */
const autoMigrateEnabled = (): boolean => GetConvar(CONVAR, 'true').toLowerCase() !== 'false';

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

/** Every table gPhone declares, primary and child alike. */
const collectPlans = async (schema: string): Promise<MigrationPlan[]> => {
  const plans: MigrationPlan[] = [];

  for (const resolved of declaredApps) {
    plans.push(planAppMigration(resolved, await readLiveTable(schema, resolved.table)));

    for (const child of resolved.childTables) {
      plans.push(planChildMigration(child, await readLiveTable(schema, child.name)));
    }
  }

  return plans;
};

const describe = (plan: MigrationPlan): string[] => {
  const lines: string[] = [];
  if (plan.missingTable) {
    lines.push(`  ${plan.table}: table does not exist — run the file in sql/apps/`);
  }
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

  /** Print what would change. Backs the `gphoneschema` command. */
  async report(): Promise<void> {
    let plans: MigrationPlan[];
    try {
      plans = await SchemaMigrator.plan();
    } catch (e) {
      console.error('[gphone] schema check failed:', e);
      return;
    }

    const interesting = plans.filter((p) => !isNoop(p));
    if (interesting.length === 0) {
      console.log('[gphone] schema is up to date.');
      return;
    }

    console.log('[gphone] schema differences:');
    for (const plan of interesting) {
      for (const line of describe(plan)) console.log(line);
    }
  },

  /**
   * Apply the additive part of every plan.
   *
   * Statements run one at a time and a failure is logged rather than thrown: one column
   * that cannot be added — a NOT NULL with no default on a populated table, say — must
   * not stop the other twenty from landing, and must not take the resource down.
   */
  async run(): Promise<void> {
    if (!autoMigrateEnabled()) {
      console.log(`[gphone] ${CONVAR} is false — skipping schema migration.`);
      return;
    }

    let plans: MigrationPlan[];
    try {
      plans = await SchemaMigrator.plan();
    } catch (e) {
      console.error('[gphone] schema migration skipped, could not read the schema:', e);
      return;
    }

    let applied = 0;
    for (const plan of plans) {
      if (plan.missingTable) {
        console.log(`[gphone] ${plan.table} does not exist — run the file in sql/apps/.`);
        continue;
      }

      for (const statement of plan.additive) {
        try {
          await Database.query(statement.sql, []);
          console.log(`[gphone] ${statement.description}`);
          applied++;
        } catch (e) {
          console.error(`[gphone] failed to ${statement.description}:`, e);
          console.error(`[gphone]   ${statement.sql}`);
        }
      }

      for (const issue of plan.drift) {
        console.warn(`[gphone] schema needs a human: ${issue}`);
      }
    }

    if (applied > 0) console.log(`[gphone] applied ${applied} schema change(s).`);
  }
};
