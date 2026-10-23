// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/**
 * The status each child table gains, frozen as MICA-429 shipped it, and the column a fresh import
 * has it after. Added with `DEFAULT 'active'`: every row that exists is live, since until now a
 * removal was a delete.
 */
const STATUSES: readonly { table: string; values: readonly string[]; after: string }[] = [
  {
    table: 'mica_account_follows',
    values: ['active', 'deleted', 'blocked', 'erased'],
    after: 'followee_account_id'
  },
  {
    table: 'mica_account_blocks',
    values: ['active', 'deleted', 'erased'],
    after: 'blocked_account_id'
  },
  { table: 'mica_account_reactions', values: ['active', 'deleted', 'erased'], after: 'emoji' },
  { table: 'mica_blabber_ears', values: ['active', 'deleted', 'erased'], after: 'account_id' },
  { table: 'mica_messages_reactions', values: ['active', 'deleted', 'erased'], after: 'emoji' },
  { table: 'mica_spark_photos', values: ['active', 'replaced', 'erased'], after: 'position' },
  { table: 'mica_spark_swipes', values: ['active', 'expired', 'deleted', 'erased'], after: 'kind' },
  { table: 'mica_spark_matches', values: ['active', 'ended', 'erased'], after: 'profile_b' },
  { table: 'mica_hodlr_price_history', values: ['active', 'expired'], after: 'price' }
];

/**
 * Each unique key that a follow again, a react again, a re-ear or the next swipe must not meet
 * the kept row under: over a live-only copy of one of its columns, NULL once the row is not
 * `active`. Still led by the column its foreign key needs, so dropping the old key leaves that
 * key its index. Frozen, as the declarations say it today.
 */
const KEYS: readonly {
  table: string;
  column: string;
  copies: string;
  key: { name: string; columns: string };
  replaces: string;
}[] = [
  {
    table: 'mica_account_follows',
    column: 'live_followee',
    copies: 'followee_account_id',
    key: { name: 'follower_live_followee', columns: '`follower_account_id`, `live_followee`' },
    replaces: 'follower_followee'
  },
  {
    table: 'mica_account_blocks',
    column: 'live_blocked',
    copies: 'blocked_account_id',
    key: { name: 'blocker_live_blocked', columns: '`blocker_account_id`, `live_blocked`' },
    replaces: 'blocker_blocked'
  },
  {
    table: 'mica_account_reactions',
    column: 'live_target',
    copies: 'target_id',
    key: {
      name: 'account_live_target_emoji',
      columns: '`account_id`, `target_table`, `live_target`, `emoji`'
    },
    replaces: 'account_target_emoji'
  },
  {
    table: 'mica_blabber_ears',
    column: 'live_account',
    copies: 'account_id',
    key: { name: 'blab_live_account', columns: '`blab_id`, `live_account`' },
    replaces: 'blab_account'
  },
  {
    table: 'mica_messages_reactions',
    column: 'live_message',
    copies: 'message_id',
    key: { name: 'live_message_citizen_emoji', columns: '`live_message`, `citizenid`, `emoji`' },
    replaces: 'message_citizen_emoji'
  },
  {
    table: 'mica_spark_swipes',
    column: 'live_target',
    copies: 'target_profile_id',
    key: { name: 'swiper_live_target', columns: '`swiper_profile_id`, `live_target`' },
    replaces: 'swiper_target'
  },
  {
    table: 'mica_spark_matches',
    column: 'live_b',
    copies: 'profile_b',
    key: { name: 'live_pair', columns: '`profile_a`, `live_b`' },
    replaces: 'pair'
  }
];

/** The two walks over kept rows, led by `status` so an expired row is never walked again. */
const INDEXES: readonly { table: string; name: string; columns: string; replaces: string }[] = [
  {
    table: 'mica_spark_swipes',
    name: 'status_kind_created_at',
    columns: '`status`, `kind`, `created_at`',
    replaces: 'kind_created_at'
  },
  {
    table: 'mica_hodlr_price_history',
    name: 'status_recorded_at',
    columns: '`status`, `recorded_at`',
    replaces: 'recorded_at'
  }
];

const expressionOf = (copies: string): string =>
  `CASE WHEN \`status\` = 'active' THEN \`${copies}\` ELSE NULL END`;

/** An expression as `information_schema` reads back, for comparing: lower case, no spaces. */
const normalized = (expression: string): string => expression.toLowerCase().replace(/\s+/g, '');

/** The values of an `enum('a','b')` column type, as information_schema spells it. */
const enumValues = (type: string): string[] | null => {
  const match = /^enum\((.*)\)$/i.exec(type.trim());
  if (!match) return null;
  return [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
};

const placeholders = (values: readonly unknown[]): string => values.map(() => '?').join(', ');

/**
 * What `information_schema` says about these tables, in two statements, not one per table and
 * column: in game each read waits for a server tick (0015's lesson, MICA-428).
 */
const schemaOf = async (
  tables: readonly string[]
): Promise<{
  columns: Map<string, { type: string; generation: string }>;
  indexes: Set<string>;
  tables: Set<string>;
}> => {
  const columns = await Database.query<
    { table: unknown; column: unknown; type: unknown; generation: unknown }[]
  >(
    `SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\`, COLUMN_TYPE AS \`type\`,
            GENERATION_EXPRESSION AS \`generation\`
       FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name IN (${placeholders(tables)})`,
    [...tables]
  );
  const indexes = await Database.query<{ table: unknown; index: unknown }[]>(
    `SELECT DISTINCT TABLE_NAME AS \`table\`, INDEX_NAME AS \`index\`
       FROM information_schema.STATISTICS
      WHERE table_schema = DATABASE() AND table_name IN (${placeholders(tables)})`,
    [...tables]
  );
  const schema = {
    columns: new Map<string, { type: string; generation: string }>(),
    indexes: new Set<string>(),
    tables: new Set<string>()
  };
  for (const r of columns ?? []) {
    schema.tables.add(String(r.table));
    schema.columns.set(`${String(r.table)}.${String(r.column)}`, {
      type: String(r.type ?? ''),
      generation: String(r.generation ?? '')
    });
  }
  for (const r of indexes ?? []) schema.indexes.add(`${String(r.table)}.${String(r.index)}`);
  return schema;
};

/**
 * MICA-429: nothing is ever hard deleted, child tables included. A follow, a block, a reaction,
 * an ear, a swipe, a match, a profile photo and a price point each gain a `status`, and every
 * removal that was a `DELETE` is a status change:
 *
 * - `deleted` an unfollow, an unblock, an unreact, an un-ear, a removed profile's swipes;
 * - `blocked` a follow a block ended, `ended` an unmatch, `replaced` a photo set's old photos;
 * - `expired` an old pass and an old price point;
 * - `erased` by a purge, with the owner or with the account or profile the row hangs off.
 *
 * The unique keys move onto a live-only copy (`KEYS`), so the row a removal keeps never refuses
 * doing it again, which is a new row beside it — never a revive, which would overwrite it.
 *
 * **Safe to run twice**: each column, key and index is read first. A table this server never
 * created is skipped; an existing `status` that is not where this would leave it is refused.
 */
export const migration: Migration = {
  id: '0016_child_rows_are_kept',
  description:
    'Eight child tables and the Hodlr price history gain a status, and seven unique keys move ' +
    'onto a live-only copy, so a removal keeps its row (follows, blocks, reactions, ears, ' +
    'swipes, matches, Spark photos, price points)',
  up: async () => {
    const tables = [...new Set([...STATUSES.map((s) => s.table), ...KEYS.map((k) => k.table)])];
    const schema = await schemaOf(tables);
    const column = (table: string, name: string) => schema.columns.get(`${table}.${name}`) ?? null;

    for (const { table, values, after } of STATUSES) {
      if (!schema.tables.has(table)) continue;
      const list = values.map((value) => `'${value}'`).join(', ');
      const current = column(table, 'status');
      if (current) {
        const have = enumValues(current.type);
        if (have && have.length === values.length && have.every((v, i) => v === values[i])) {
          continue;
        }
        throw new Error(
          `${table}.status is '${current.type}', not enum(${list}); change it by hand.`
        );
      }
      await Database.query(
        `ALTER TABLE \`${table}\` ADD COLUMN \`status\` ENUM(${list}) NOT NULL DEFAULT 'active'` +
          (column(table, after) ? ` AFTER \`${after}\`` : ''),
        []
      );
    }

    for (const spec of KEYS) {
      if (!schema.tables.has(spec.table)) continue;
      const current = column(spec.table, spec.column);
      const keyed = schema.indexes.has(`${spec.table}.${spec.key.name}`);
      const replaced = schema.indexes.has(`${spec.table}.${spec.replaces}`);
      const expression = expressionOf(spec.copies);
      const restated = current
        ? normalized(current.generation).includes(normalized(expression))
        : false;
      if (restated && keyed && !replaced) continue;
      await Database.query(
        `ALTER TABLE \`${spec.table}\` ` +
          [
            ...(replaced ? [`DROP KEY \`${spec.replaces}\``] : []),
            ...(keyed ? [`DROP KEY \`${spec.key.name}\``] : []),
            ...(current ? [`DROP COLUMN \`${spec.column}\``] : []),
            `ADD COLUMN \`${spec.column}\` int(11) GENERATED ALWAYS AS (${expression}) VIRTUAL` +
              (column(spec.table, spec.copies) ? ` AFTER \`${spec.copies}\`` : ''),
            `ADD UNIQUE KEY \`${spec.key.name}\` (${spec.key.columns})`
          ].join(', '),
        []
      );
    }

    for (const index of INDEXES) {
      if (!schema.tables.has(index.table)) continue;
      const added = schema.indexes.has(`${index.table}.${index.name}`);
      const replaced = schema.indexes.has(`${index.table}.${index.replaces}`);
      if (added && !replaced) continue;
      await Database.query(
        `ALTER TABLE \`${index.table}\` ` +
          [
            ...(replaced ? [`DROP KEY \`${index.replaces}\``] : []),
            ...(added ? [] : [`ADD KEY \`${index.name}\` (${index.columns})`])
          ].join(', '),
        []
      );
    }
  }
};
