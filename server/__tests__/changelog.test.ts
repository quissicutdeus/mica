// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { declaredServices, normalizeIndex } from '../lib/defineService';
import { expectedShape } from '../lib/schemaSql';
import '../services/index';

/**
 * Every schema change an owner has to act on is announced to them, enforced.
 *
 * MICA-72 asked for a CHANGELOG that a release could not silently ship without.
 * The obvious form of that check — "does this tag have a section" — is the wrong
 * one here: `release.yml` cuts a CalVer tag on every push to `main`, eleven of
 * them on 2026-08-27 alone and several one commit apart, so a per-tag rule would
 * demand a release note for a chore and would be routed around within a week. A
 * gate that cries wolf gets bypassed, and then it is worse than no gate.
 *
 * So the rule is tied to what an owner must actually *do* rather than to the tag,
 * and there are exactly two things that put `micaschema apply` in front of them
 * (AGENTS.md §8):
 *
 *   1. A **versioned migration** in `server/migrations/` — a rename, retype,
 *      widened enum or drop.
 *   2. An **additive change** to a `defineService` declaration — a new column or
 *      a new index, applied by the second half of `micaschema apply`.
 *
 * This file used to check only the first, and that was a check which could not
 * run: `server/migrations/` holds `index.ts` and nothing else, so the assertion
 * passed over an empty set on every commit that has ever been made. Meanwhile the
 * change that actually reaches an install — an `ADD COLUMN` — was outside its
 * reach entirely. A column could land, ship, and leave an existing database a
 * column short with the CHANGELOG silent and the build green. That was verified,
 * not assumed: adding `best_streak` to the `highscores` declaration ran the whole
 * server suite green, 1058 of 1058.
 *
 * Both halves now scan for the real thing and hold the prose to it, the same
 * shape as `convars.test.ts` and `eventNames.test.ts`.
 *
 * ## Where an announcement has to be, and why there (MICA-309)
 *
 * The additive half used to accept a column when its table and its name were
 * each written *anywhere* in the file, and an index when only its **table** was.
 * Most tables are named in some older entry, so an index on any of them could
 * never turn this red: MICA-307's `participant_b_status` on
 * `mica_messages_conversations` passed before its entry existed. The column half
 * had the same hole one size smaller — a generic name (`title`, `status`) on a
 * table the file already names was satisfied by two unrelated lines.
 *
 * So a change on a table the baseline knows is announced only by **one entry —
 * a blank-line-separated block — that names both the table and the change's own
 * name** in code spans (`table.name` in a single span counts), and only inside
 * `## Unreleased` or a section dated on or after the baseline. A table that is
 * itself new since the baseline is announced by its own name in that window: its
 * entry says "new table", and `micaschema apply` creates every column and key of
 * it at once. Nothing here knows the day a given change landed (that would mean
 * reading git, which the comment in the suite below rules out), so the baseline's
 * date is the floor: an entry older than the baseline cannot be about a change
 * made after it. A changelog whose `## ` headings this cannot read — no
 * `Unreleased`, two of them, or a heading that is not a date — fails the suite
 * rather than shrinking the window to nothing.
 *
 * ## What this cannot see, said plainly
 *
 * - **The audit ledger** (`auditLogDdl` in `server/lib/schemaSql.ts`), which has
 *   no declaration behind it, so nothing here derives its shape.
 * - **A drop of a column added *after* this baseline was frozen.** Removals are
 *   detected against the baseline, and a post-baseline column was never in it. It
 *   is already named in the CHANGELOG from the entry that introduced it, so the
 *   matcher would accept it regardless.
 * - **A column or key added later to a table that is itself new since the
 *   baseline.** Such a table is announced by its name, so a second change to it
 *   is accepted on the first change's entry. The same table-name-only hole as
 *   MICA-309, confined to post-baseline tables; closing it means knowing the
 *   table's shape at the day it was announced, which is git again.
 * - **Two changes in one entry.** An entry naming the table and both columns
 *   announces both, whether or not the sentence around them is about either.
 * - **A type or length change in place** — `varchar(64)` widened to
 *   `varchar(255)`. That is neither a new name nor a lost one; it needs a
 *   versioned migration, which rule 1 covers, but nothing here notices if the
 *   declaration is edited without one.
 * - **Whether the prose is any good.** The matcher asks that the identifier was
 *   written down, not that a particular sentence was.
 */
const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'server', 'migrations');
const CHANGELOG = 'CHANGELOG.md';

/**
 * The schema as it stood on 2026-08-29, when the additive half of this gate was
 * written. **Frozen, and not a file anybody maintains.**
 *
 * Everything listed here predates the CHANGELOG's coverage and needs no entry.
 * Everything the declarations grow past it does, and stays announced forever once
 * it is written down — so this list never needs bumping at a release, and there is
 * no periodic chore to forget. The one way to route around the gate is to add a
 * line here instead of writing the entry, and that is a deliberate, reviewable lie
 * in a diff rather than a silence.
 *
 * Derived from `expectedShape()` over every `declaredServices` entry plus its
 * `childTables`, which is exactly what `pnpm generate:sql` emits and what
 * `micaschema apply` compares a live database against.
 */
const BASELINE: Record<string, { columns: string[]; indexes: string[] }> = {
  mica_account_blocks: {
    columns: ['blocked_account_id', 'blocker_account_id', 'created_at', 'id'],
    indexes: ['blocked_account_id', 'blocker_blocked']
  },
  mica_account_follows: {
    columns: ['created_at', 'followee_account_id', 'follower_account_id', 'id'],
    indexes: ['followee_account_id', 'follower_followee', 'follower_recent']
  },
  mica_account_reactions: {
    columns: ['account_id', 'created_at', 'emoji', 'id', 'target_id', 'target_table'],
    indexes: ['account_target_emoji', 'target']
  },
  mica_accounts: {
    columns: [
      'app',
      'avatar',
      'bio',
      'citizenid',
      'created_at',
      'display_name',
      'handle',
      'id',
      'status',
      'updated_at'
    ],
    indexes: ['app_handle', 'citizenid_app', 'citizenid_status', 'status']
  },
  mica_battery: {
    columns: ['citizenid', 'created_at', 'id', 'level', 'status', 'updated_at'],
    indexes: ['citizenid_status', 'citizenid_unique', 'status']
  },
  mica_blabber: {
    columns: [
      'account_id',
      'body',
      'citizenid',
      'created_at',
      'id',
      'mouth_of',
      'reply_to',
      'root_id',
      'status',
      'updated_at'
    ],
    indexes: ['account_id', 'account_mouth', 'citizenid_status', 'reply_to', 'root_id', 'status']
  },
  mica_blabber_attachments: {
    columns: ['blab_id', 'citizenid', 'id', 'media_id'],
    indexes: ['blab_id', 'citizenid', 'media_id']
  },
  mica_blabber_dms: {
    columns: [
      'body',
      'citizenid',
      'created_at',
      'from_account',
      'id',
      'read_at',
      'status',
      'to_account',
      'updated_at'
    ],
    indexes: ['citizenid_status', 'from_to', 'status', 'to_from', 'to_unread']
  },
  mica_blabber_ears: {
    columns: ['account_id', 'blab_id', 'created_at', 'id'],
    indexes: ['account_id', 'blab_account']
  },
  mica_blabber_tags: {
    columns: ['blab_id', 'id', 'tag'],
    indexes: ['blab_id', 'tag']
  },
  mica_contacts: {
    columns: [
      'avatar',
      'citizenid',
      'created_at',
      'email',
      'favorite',
      'firstname',
      'id',
      'lastname',
      'phone',
      'status',
      'updated_at'
    ],
    indexes: ['citizenid_favorite', 'citizenid_phone', 'citizenid_status', 'phone', 'status']
  },
  mica_highscores: {
    columns: ['app', 'citizenid', 'created_at', 'id', 'score', 'status', 'updated_at'],
    indexes: ['citizenid_app', 'citizenid_status', 'status']
  },
  mica_hodlr: {
    columns: ['citizenid', 'created_at', 'id', 'quantity', 'status', 'updated_at'],
    indexes: ['citizenid_status', 'citizenid_unique', 'status']
  },
  mica_hodlr_price_history: {
    columns: ['id', 'price', 'recorded_at'],
    indexes: ['recorded_at']
  },
  mica_mail: {
    columns: [
      'citizenid',
      'content',
      'created_at',
      'id',
      'read',
      'sender',
      'sender_address',
      'status',
      'subject',
      'updated_at'
    ],
    indexes: ['citizenid_read_status', 'citizenid_status', 'citizenid_status_created', 'status']
  },
  mica_marketplace: {
    columns: [
      'citizenid',
      'created_at',
      'description',
      'id',
      'price',
      'status',
      'title',
      'updated_at'
    ],
    indexes: ['citizenid_status', 'status']
  },
  mica_marketplace_attachments: {
    columns: ['citizenid', 'id', 'listing_id', 'media_id'],
    indexes: ['citizenid', 'listing_id', 'media_id']
  },
  mica_media: {
    columns: [
      'alt_text',
      'byte_size',
      'citizenid',
      'created_at',
      'data',
      'duration_ms',
      'height',
      'id',
      'kind',
      'mime_type',
      'status',
      'thumbnail',
      'updated_at',
      'url',
      'width'
    ],
    indexes: ['citizenid_status', 'citizenid_status_created', 'status']
  },
  mica_messages: {
    columns: [
      'citizenid',
      'conversation_id',
      'created_at',
      'id',
      'message',
      'status',
      'updated_at'
    ],
    indexes: ['citizenid', 'citizenid_status', 'conversation_status_created', 'status']
  },
  mica_messages_attachments: {
    columns: ['citizenid', 'id', 'message_id', 'photo_id'],
    indexes: ['citizenid', 'message_id', 'photo_id']
  },
  mica_messages_conversations: {
    columns: ['citizenid', 'created_at', 'id', 'is_group', 'name', 'status', 'updated_at'],
    indexes: ['citizenid_status', 'citizenid_status_updated', 'status', 'updated_at']
  },
  mica_messages_participants: {
    columns: [
      'archived_at',
      'citizenid',
      'conversation_id',
      'created_at',
      'id',
      'last_read',
      'left_at',
      'role',
      'status',
      'updated_at'
    ],
    indexes: [
      'citizenid_status',
      'conversation_participant',
      'conversation_status',
      'participant_last_read',
      'status'
    ]
  },
  mica_notes: {
    columns: ['citizenid', 'content', 'created_at', 'id', 'status', 'title', 'updated_at'],
    indexes: ['citizenid_status', 'citizenid_status_updated', 'status']
  },
  mica_notifications: {
    columns: [
      'app',
      'avatar',
      'body',
      'citizenid',
      'cleared_at',
      'created_at',
      'deep_link',
      'id',
      'kind',
      'read_at',
      'status',
      'title',
      'updated_at'
    ],
    indexes: [
      'citizenid_app_id',
      'citizenid_cleared_id',
      'citizenid_read',
      'citizenid_status',
      'status'
    ]
  },
  mica_phone_call_log: {
    columns: [
      'citizenid',
      'created_at',
      'duration',
      'id',
      'kind',
      'number',
      'status',
      'updated_at'
    ],
    indexes: ['citizenid_status', 'citizenid_status_created', 'status']
  },
  mica_reports: {
    columns: [
      'category',
      'citizenid',
      'created_at',
      'id',
      'note',
      'resolution',
      'status',
      'target_author',
      'target_id',
      'target_preview',
      'target_table',
      'updated_at'
    ],
    indexes: ['citizenid_status', 'resolution_created', 'status', 'target']
  },
  mica_settings: {
    columns: [
      'app',
      'citizenid',
      'created_at',
      'id',
      'setting_key',
      'setting_value',
      'status',
      'updated_at'
    ],
    indexes: ['citizenid_app_key', 'citizenid_status', 'status']
  }
};

/**
 * The day `BASELINE` was frozen, and so the oldest a section can be and still
 * announce a change past it. A dated section older than this was written about
 * a schema the baseline already holds.
 */
const BASELINE_DATE = '2026-08-29';

/**
 * The id of each versioned migration — the filename stem, which is what the
 * runner uses and what `migrationsSeed.test.ts` already pins the filename to.
 * `index.ts` is the generated ordered array, not a migration.
 */
const migrationIds = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith('.ts') && entry !== 'index.ts')
    .map((entry) => entry.replace(/\.ts$/, ''))
    .sort();

/**
 * Pure so the probes below can drive it with input this repo does not have yet.
 * A migration counts as announced if the changelog names its id anywhere; the
 * prose around it is the author's job, not this file's.
 */
const unannounced = (ids: string[], changelog: string): string[] =>
  ids.filter((id) => !changelog.includes(id));

const changelogText = (): string => readFileSync(join(ROOT, CHANGELOG), 'utf8');

/** `## YYYY-MM-DD` section headings, in the order they appear in the file. */
const datedSections = (changelog: string): string[] =>
  [...changelog.matchAll(/^## (\d{4}-\d{2}-\d{2})\s*$/gm)].map((m) => m[1]);

/** A real calendar day written `YYYY-MM-DD` — `2026-13-40` has the shape and is not one. */
const isIsoDate = (text: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(text) &&
  !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) &&
  new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);

/** One `## ` section: its heading text and everything up to the next `## `. */
interface Section {
  heading: string;
  body: string;
}

/** The `## ` sections in file order. The preamble above the first is not one. */
const sections = (markdown: string): Section[] => {
  const out: Section[] = [];
  for (const line of markdown.split('\n')) {
    const heading = /^## (.*?)\s*$/.exec(line);
    if (heading) out.push({ heading: heading[1], body: '' });
    else if (out.length > 0) out[out.length - 1].body += `${line}\n`;
  }
  return out;
};

/**
 * The part of the changelog that can announce a change made after `since`:
 * `## Unreleased`, plus every section dated on or after `since`.
 *
 * Throws rather than returning less when it cannot read the headings. A window
 * that silently came back empty would report every change as missing, which is
 * loud — but one that silently came back as the whole file would accept a stale
 * entry, which is the defect this exists to close (MICA-309). Neither is a
 * judgement this function is entitled to make, so a heading it does not
 * understand stops the suite.
 */
const announcementWindow = (changelog: string, since: string): string => {
  const all = sections(changelog);
  const unreleased = all.filter((s) => s.heading === 'Unreleased').length;
  if (unreleased !== 1) {
    throw new Error(
      `${CHANGELOG} has ${unreleased} "## Unreleased" sections, not one — the schema ` +
        `check cannot tell which entries are new enough to announce a change`
    );
  }
  const kept: string[] = [];
  for (const { heading, body } of all) {
    if (heading !== 'Unreleased' && !isIsoDate(heading)) {
      throw new Error(
        `"## ${heading}" in ${CHANGELOG} is neither "Unreleased" nor a YYYY-MM-DD date — ` +
          `the schema check cannot place it before or after ${since}`
      );
    }
    if (heading === 'Unreleased' || heading >= since) kept.push(body);
  }
  return kept.join('\n');
};

/** Blank-line-separated blocks: a paragraph, or a list written without gaps. */
const entries = (markdown: string): string[] =>
  markdown.split(/\n[ \t]*\n/).filter((block) => block.trim() !== '');

/** A table's shape, reduced to the two things `micaschema apply` can add. */
interface TableShape {
  columns: string[];
  indexes: string[];
}

/**
 * What the declarations say every table looks like, right now.
 *
 * Derived rather than read out of `mica.sql`, deliberately. The declaration is
 * the source of truth (AGENTS.md §8, "a schema change is written once, in the
 * declaration") and `mica.sql` is regenerated from it — so a scan of the SQL
 * would go blind for exactly as long as somebody forgot to regenerate, which is
 * the window this gate most needs to see into.
 */
const liveSchema = (): Record<string, TableShape> => {
  const out: Record<string, TableShape> = {};
  for (const service of declaredServices) {
    const shape = expectedShape(service);
    out[service.table] = {
      columns: shape.columns.map((c) => c.name).sort(),
      indexes: shape.indexes.map((i) => i.name).sort()
    };
    for (const child of service.childTables) {
      out[child.name] = {
        columns: [
          ...(child.autoIncrementId === false ? [] : ['id']),
          ...Object.keys(child.columns)
        ].sort(),
        indexes: (child.indexes ?? []).map((i) => normalizeIndex(i).name).sort()
      };
    }
  }
  return out;
};

/** One schema difference, in the words the failure message uses. */
interface SchemaChange {
  table: string;
  /** The column or index name. */
  name: string;
  kind: 'column' | 'index';
  direction: 'added' | 'removed';
  /** The whole table is absent from the baseline, so its own entry announces it. */
  newTable: boolean;
}

/** Every table/column/index difference between the declarations and the baseline. */
const schemaDrift = (
  live: Record<string, TableShape>,
  baseline: Record<string, TableShape>
): SchemaChange[] => {
  const changes: SchemaChange[] = [];
  const tables = [...new Set([...Object.keys(live), ...Object.keys(baseline)])].sort();

  for (const table of tables) {
    const now = live[table] ?? { columns: [], indexes: [] };
    const then = baseline[table] ?? { columns: [], indexes: [] };
    const newTable = !(table in baseline);

    for (const kind of ['column', 'index'] as const) {
      const key = kind === 'column' ? 'columns' : 'indexes';
      for (const name of now[key]) {
        if (!then[key].includes(name)) {
          changes.push({ table, name, kind, direction: 'added', newTable });
        }
      }
      for (const name of then[key]) {
        if (!now[key].includes(name)) {
          changes.push({ table, name, kind, direction: 'removed', newTable });
        }
      }
    }
  }
  return changes;
};

/**
 * The text of every inline code span in a markdown document, run together.
 *
 * The matcher reads code spans rather than the whole file because this changelog
 * writes every identifier in backticks — `mica_media`, `mica_music_range`,
 * `micaschema apply` — and a column called `url` or `role` would otherwise be
 * "announced" by the word appearing in an unrelated sentence. That is a structural
 * convention, not a required sentence: what the entry says about the column is
 * still entirely the author's.
 */
const codeSpans = (markdown: string): string =>
  [...markdown.matchAll(/`+([^`\n]+)`+/g)].map((m) => m[1]).join('   ');

/**
 * Is `name` written down as an identifier somewhere in those code spans?
 *
 * The boundary is "not a letter or a digit" rather than `\b`, so a migration id
 * like `0001_drop_highscores_best_streak` announces the `best_streak` it drops.
 */
const isNamed = (name: string, spans: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9])${name.replace(/[^A-Za-z0-9_]/g, '')}(?![A-Za-z0-9])`).test(spans);

/**
 * The schema changes an owner would not learn about by reading the CHANGELOG.
 *
 * Only `announcementWindow` counts — `## Unreleased` and sections dated on or
 * after `since`. Inside it, a change on a table the baseline knows is announced
 * by one entry naming both the table and the column or index itself; a change on
 * a table new since the baseline, by the table's name alone. The header of this
 * file has why each half of that is there.
 *
 * An index is held to its own name, the same as a column. It used to be held to
 * its table only, on the reasoning that a derived name is noise to an owner —
 * and since nearly every table is named somewhere, that made the index half a
 * check that could not fail (MICA-309). One backticked name in the sentence that
 * already says "gains an index" costs the author nothing.
 *
 * Pure, so the probes below can drive it with input this repo does not have.
 */
const unannouncedSchemaChanges = (
  changes: SchemaChange[],
  changelog: string,
  since: string = BASELINE_DATE
): string[] => {
  const window = entries(announcementWindow(changelog, since)).map(codeSpans);
  const anywhere = window.join('   ');
  return changes
    .filter(({ table, name, newTable }) =>
      newTable
        ? !isNamed(table, anywhere)
        : !window.some((spans) => isNamed(table, spans) && isNamed(name, spans))
    )
    .map(({ table, name, kind, direction }) => `${table}.${name} (${kind} ${direction})`);
};

/** A one-table schema for the probes, which need input this repo does not have. */
const shapes = (columns: string[], indexes: string[] = []) => ({
  mica_widgets: { columns, indexes }
});

describe('changelog (MICA-72)', () => {
  it('announces every versioned migration', () => {
    const missing = unannounced(migrationIds(), changelogText());

    expect(
      missing,
      `a migration makes an update need \`micaschema apply\` — name it in ${CHANGELOG} ` +
        `under "Action required", so an owner reads it before pulling`
    ).toEqual([]);
  });

  describe('additive schema changes', () => {
    const live = liveSchema();

    // Nothing here reads git, a diff, a parent commit or a merge base, and that is
    // the point: those answer differently on a shallow CI clone, on a clean tree
    // and mid-rebase, so a gate built on one is a gate that runs in one place. The
    // inputs are the declarations and a frozen list in this file, so a local run
    // and a CI run see the same thing or both fail.
    it('reads the declarations, so the check below is not vacuous', () => {
      const columns = Object.values(live).reduce((n, t) => n + t.columns.length, 0);

      expect(
        Object.keys(live).length,
        'no declared tables found — the service imports failed and this file is checking nothing'
      ).toBeGreaterThanOrEqual(20);
      expect(columns).toBeGreaterThanOrEqual(150);
    });

    it('has a baseline to compare against', () => {
      // Emptied, truncated or half-deleted, this file would otherwise report every
      // table as unchanged and pass. AGENTS.md is explicit that a check which
      // cannot run reads as a pass.
      expect(
        Object.keys(BASELINE).length,
        'the frozen baseline is missing — restore it rather than letting the gate go quiet'
      ).toBeGreaterThanOrEqual(20);
    });

    it('announces every column and key an owner will have to apply', () => {
      const missing = unannouncedSchemaChanges(schemaDrift(live, BASELINE), changelogText());

      expect(
        missing,
        `a new column or key makes an update need \`micaschema apply\` on every existing ` +
          `install — name the table and the column or key's own name in backticks, in one ` +
          `entry under "## Unreleased" > "Action required" in ${CHANGELOG}, so an owner ` +
          `reads it before pulling. A removal needs a versioned migration as well ` +
          `(AGENTS.md §8).`
      ).toEqual([]);
    });

    // The two cases below run the real declarations and the real CHANGELOG, so the
    // proof that the check fires does not rest on synthetic input alone.
    it('reports a key added to a real table the changelog already names (MICA-309)', () => {
      const table = 'mica_messages_conversations';
      const grown = { ...live, [table]: { ...live[table], indexes: [...live[table].indexes] } };
      grown[table].indexes.push('mica309_probe_key');
      const window = codeSpans(announcementWindow(changelogText(), BASELINE_DATE));

      expect(isNamed(table, window), `${table} is no longer named — pick a table that is`).toBe(
        true
      );
      expect(
        unannouncedSchemaChanges(schemaDrift(grown, BASELINE), changelogText()).filter((line) =>
          line.includes('mica309_probe_key')
        )
      ).toEqual([`${table}.mica309_probe_key (index added)`]);
    });

    it('reports MICA-307 again once its own entry is taken out', () => {
      // The case that surfaced the defect, replayed: the index is still declared,
      // the table is still named by other entries, and only its own entry is gone.
      const without = entries(changelogText())
        .filter((entry) => !entry.includes('participant_b_status'))
        .join('\n\n');
      const drift = schemaDrift(live, BASELINE).filter((c) => c.name === 'participant_b_status');

      expect(drift, 'the MICA-307 index is no longer declared — retire this case').toHaveLength(1);
      expect(
        isNamed(drift[0].table, codeSpans(announcementWindow(without, BASELINE_DATE))),
        'the table is no longer named elsewhere, so this no longer replays MICA-309'
      ).toBe(true);
      expect(unannouncedSchemaChanges(drift, without)).toEqual([
        'mica_messages_conversations.participant_b_status (index added)'
      ]);
    });
  });

  // The migration set is empty and the schema matches its baseline, so both
  // assertions above pass over nothing. These drive the same matchers with input
  // of both kinds, so "nothing to announce" is a verified silence rather than a
  // scan that quietly matches nothing.
  describe('the check fires, rather than merely being configured', () => {
    const probe = '0001_probe_that_is_not_in_the_changelog';

    it('reports a migration the changelog does not name', () => {
      expect(unannounced([probe], '# Changelog\n\nNothing here.\n')).toEqual([probe]);
    });

    it('accepts one it does', () => {
      expect(unannounced([probe], `# Changelog\n\n- ${probe}: adds a column.\n`)).toEqual([]);
    });

    it('sees a column the declarations grew', () => {
      expect(schemaDrift(shapes(['id', 'label']), shapes(['id']))).toEqual([
        {
          table: 'mica_widgets',
          name: 'label',
          kind: 'column',
          direction: 'added',
          newTable: false
        }
      ]);
    });

    it('sees a column they lost, and a key either way', () => {
      expect(schemaDrift(shapes(['id'], ['a']), shapes(['id', 'label'], ['b']))).toEqual([
        {
          table: 'mica_widgets',
          name: 'label',
          kind: 'column',
          direction: 'removed',
          newTable: false
        },
        { table: 'mica_widgets', name: 'a', kind: 'index', direction: 'added', newTable: false },
        { table: 'mica_widgets', name: 'b', kind: 'index', direction: 'removed', newTable: false }
      ]);
    });

    it('marks every change on a table the baseline lacks as part of a new table', () => {
      expect(schemaDrift(shapes(['id'], ['a']), {})).toEqual([
        { table: 'mica_widgets', name: 'id', kind: 'column', direction: 'added', newTable: true },
        { table: 'mica_widgets', name: 'a', kind: 'index', direction: 'added', newTable: true }
      ]);
    });

    /**
     * A changelog of this file's shape: an `Unreleased` section, then dated ones.
     * `older` is a section from before the baseline — where MICA-307's table was
     * already named, and from where it must no longer count.
     */
    const changelogOf = (unreleased: string, dated: Record<string, string> = {}): string =>
      [
        '# Changelog\n\nPreamble naming `mica_widgets` and `label`, which is not a section.\n',
        `## Unreleased\n\n${unreleased}\n`,
        ...Object.entries(dated).map(([date, body]) => `## ${date}\n\n${body}\n`)
      ].join('\n');
    const older = { '2026-08-27': '- `mica_widgets` gains `label` and `citizenid_updated`.' };

    const added: SchemaChange = {
      table: 'mica_widgets',
      name: 'label',
      kind: 'column',
      direction: 'added',
      newTable: false
    };
    const index: SchemaChange = { ...added, name: 'citizenid_updated', kind: 'index' };

    it('reports a column the changelog does not name', () => {
      expect(unannouncedSchemaChanges([added], changelogOf('Nothing here.'))).toEqual([
        'mica_widgets.label (column added)'
      ]);
    });

    it('accepts one written down as prose plus identifiers', () => {
      const entry = '- `mica_widgets` gains a `label`; run `micaschema apply`.';

      expect(unannouncedSchemaChanges([added], changelogOf(entry))).toEqual([]);
    });

    it('is not satisfied by the words appearing outside a code span', () => {
      // The failure this prevents: an entry about something else that happens to
      // use the word, read as an announcement of this column.
      const prose = 'The widgets table now shows a label on each row.';

      expect(unannouncedSchemaChanges([added], changelogOf(prose))).toEqual([
        'mica_widgets.label (column added)'
      ]);
    });

    it('holds an index to its own name, not to its table (MICA-309)', () => {
      // The defect: `mica_widgets` named in any entry used to announce every key
      // the table would ever grow.
      const tableOnly = '- `mica_widgets` gains a key; run `micaschema apply`.';

      expect(unannouncedSchemaChanges([index], changelogOf(tableOnly))).toEqual([
        'mica_widgets.citizenid_updated (index added)'
      ]);
      expect(
        unannouncedSchemaChanges(
          [index],
          changelogOf('- `mica_widgets` gains an index, `citizenid_updated`.')
        )
      ).toEqual([]);
    });

    it('accepts `table.index` written as one span', () => {
      expect(
        unannouncedSchemaChanges(
          [index],
          changelogOf('- New key `mica_widgets.citizenid_updated`.')
        )
      ).toEqual([]);
    });

    it('needs the table and the name in one entry, not two unrelated ones', () => {
      // The column half's version of MICA-309: a generic name (`label`, `status`)
      // on a table some other entry names, satisfied by the two lines together.
      const apart =
        '- `mica_widgets` is faster to open.\n\n- Mail shows a `label` beside each sender.';

      expect(unannouncedSchemaChanges([added, index], changelogOf(apart))).toEqual([
        'mica_widgets.label (column added)',
        'mica_widgets.citizenid_updated (index added)'
      ]);
    });

    it('does not count a section dated before the baseline', () => {
      expect(unannouncedSchemaChanges([added, index], changelogOf('Nothing.', older))).toEqual([
        'mica_widgets.label (column added)',
        'mica_widgets.citizenid_updated (index added)'
      ]);
    });

    it('counts a section dated on or after the baseline, as a cut release is', () => {
      const released = { '2026-09-14': older['2026-08-27'], ...older };

      expect(unannouncedSchemaChanges([added, index], changelogOf('', released))).toEqual([]);
      expect(
        unannouncedSchemaChanges(
          [added],
          changelogOf('', { [BASELINE_DATE]: '`mica_widgets.label`' })
        )
      ).toEqual([]);
    });

    it('lets a new table be announced by its own name', () => {
      // `micaschema apply` creates the table whole, so the entry that says "new
      // table" covers every column and key in it.
      const fresh = [added, index].map((change) => ({ ...change, newTable: true }));

      expect(
        unannouncedSchemaChanges(fresh, changelogOf('- `mica_widgets` is a new table.'))
      ).toEqual([]);
      expect(unannouncedSchemaChanges(fresh, changelogOf('Nothing.', older))).toEqual([
        'mica_widgets.label (column added)',
        'mica_widgets.citizenid_updated (index added)'
      ]);
    });

    it('lets a migration id announce the column it drops', () => {
      const dropped: SchemaChange = { ...added, name: 'best_streak', direction: 'removed' };
      const entry = '- `0001_drop_mica_widgets_best_streak` — run it.';

      expect(unannouncedSchemaChanges([dropped], changelogOf(entry))).toEqual([]);
    });

    describe('fails, rather than passes, on a changelog it cannot read', () => {
      it('with no Unreleased section', () => {
        expect(() => unannouncedSchemaChanges([], '# Changelog\n\n## 2026-09-14\n\nx\n')).toThrow(
          /0 "## Unreleased" sections/
        );
      });

      it('with two', () => {
        expect(() =>
          unannouncedSchemaChanges([], `${changelogOf('a')}\n## Unreleased\n\nb\n`)
        ).toThrow(/2 "## Unreleased" sections/);
      });

      it('with a heading that is not a date', () => {
        expect(() =>
          unannouncedSchemaChanges([], changelogOf('a', { 'v2026.09.14.3': 'b' }))
        ).toThrow(/"## v2026\.09\.14\.3" .* neither/);
      });

      it('with a date that is not a day', () => {
        expect(() => unannouncedSchemaChanges([], changelogOf('a', { '2026-13-40': 'b' }))).toThrow(
          /"## 2026-13-40"/
        );
      });

      it('even when there are no changes to judge', () => {
        // A tree whose schema matches the baseline must still prove the window can
        // be read, or the day it next changes is the first day this is tested.
        expect(() => unannouncedSchemaChanges([], '# Changelog\n')).toThrow(/Unreleased/);
      });
    });

    it('reads the real changelog, so a missing or empty file is a failure', () => {
      // A file this scan cannot read is a file it cannot check. Reading it here
      // means a deleted or truncated CHANGELOG.md fails loudly instead of
      // turning every assertion above into a pass over an empty string.
      expect(changelogText().length).toBeGreaterThan(500);
      // And a file with no code spans left in it would announce nothing, which
      // would read as "every identifier is missing" rather than as a pass — but
      // only if the extractor works at all.
      expect(codeSpans(changelogText()).length).toBeGreaterThan(100);
      // The same for the part of it that can announce a schema change: a window
      // that parsed to nothing would report every change, and one that was
      // nothing because every entry moved under an old date would too.
      expect(codeSpans(announcementWindow(changelogText(), BASELINE_DATE)).length).toBeGreaterThan(
        100
      );
    });
  });

  describe('stays readable as it grows', () => {
    it('keeps an Unreleased section for work that has not shipped', () => {
      // Without it there is nowhere to write an entry between releases, and the
      // entry gets written after the tag or not at all.
      expect(changelogText()).toMatch(/^## Unreleased\s*$/m);
    });

    it('orders dated sections newest first', () => {
      const dates = datedSections(changelogText());

      expect(dates.length, 'no dated sections found — the heading format changed').toBeGreaterThan(
        0
      );
      expect(dates, 'a reader looking for the newest release reads from the top').toEqual(
        [...dates].sort().reverse()
      );
    });
  });
});
