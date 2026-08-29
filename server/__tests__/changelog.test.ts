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
 * and there are exactly two things that put `gphoneschema apply` in front of them
 * (AGENTS.md §8):
 *
 *   1. A **versioned migration** in `server/migrations/` — a rename, retype,
 *      widened enum or drop.
 *   2. An **additive change** to a `defineService` declaration — a new column or
 *      a new index, applied by the second half of `gphoneschema apply`.
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
 * ## What this cannot see, said plainly
 *
 * - **`scripts/framework-schema.sql`**, which is hand-written and has no
 *   declaration behind it, so nothing here derives its shape.
 * - **A drop of a column added *after* this baseline was frozen.** Removals are
 *   detected against the baseline, and a post-baseline column was never in it. It
 *   is already named in the CHANGELOG from the entry that introduced it, so the
 *   matcher would accept it regardless.
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
 * `gphoneschema apply` compares a live database against.
 */
const BASELINE: Record<string, { columns: string[]; indexes: string[] }> = {
  gphone_account_blocks: {
    columns: ['blocked_account_id', 'blocker_account_id', 'created_at', 'id'],
    indexes: ['blocked_account_id', 'blocker_blocked']
  },
  gphone_account_follows: {
    columns: ['created_at', 'followee_account_id', 'follower_account_id', 'id'],
    indexes: ['followee_account_id', 'follower_followee', 'follower_recent']
  },
  gphone_account_reactions: {
    columns: ['account_id', 'created_at', 'emoji', 'id', 'target_id', 'target_table'],
    indexes: ['account_target_emoji', 'target']
  },
  gphone_accounts: {
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
  gphone_battery: {
    columns: ['citizenid', 'created_at', 'id', 'level', 'status', 'updated_at'],
    indexes: ['citizenid_status', 'citizenid_unique', 'status']
  },
  gphone_blabber: {
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
  gphone_blabber_attachments: {
    columns: ['blab_id', 'citizenid', 'id', 'media_id'],
    indexes: ['blab_id', 'citizenid', 'media_id']
  },
  gphone_blabber_dms: {
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
  gphone_blabber_ears: {
    columns: ['account_id', 'blab_id', 'created_at', 'id'],
    indexes: ['account_id', 'blab_account']
  },
  gphone_blabber_tags: {
    columns: ['blab_id', 'id', 'tag'],
    indexes: ['blab_id', 'tag']
  },
  gphone_contacts: {
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
  gphone_highscores: {
    columns: ['app', 'citizenid', 'created_at', 'id', 'score', 'status', 'updated_at'],
    indexes: ['citizenid_app', 'citizenid_status', 'status']
  },
  gphone_hodlr: {
    columns: ['citizenid', 'created_at', 'id', 'quantity', 'status', 'updated_at'],
    indexes: ['citizenid_status', 'citizenid_unique', 'status']
  },
  gphone_hodlr_price_history: {
    columns: ['id', 'price', 'recorded_at'],
    indexes: ['recorded_at']
  },
  gphone_mail: {
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
  gphone_marketplace: {
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
  gphone_marketplace_attachments: {
    columns: ['citizenid', 'id', 'listing_id', 'media_id'],
    indexes: ['citizenid', 'listing_id', 'media_id']
  },
  gphone_media: {
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
  gphone_messages: {
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
  gphone_messages_attachments: {
    columns: ['citizenid', 'id', 'message_id', 'photo_id'],
    indexes: ['citizenid', 'message_id', 'photo_id']
  },
  gphone_messages_conversations: {
    columns: ['citizenid', 'created_at', 'id', 'is_group', 'name', 'status', 'updated_at'],
    indexes: ['citizenid_status', 'citizenid_status_updated', 'status', 'updated_at']
  },
  gphone_messages_participants: {
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
  gphone_notes: {
    columns: ['citizenid', 'content', 'created_at', 'id', 'status', 'title', 'updated_at'],
    indexes: ['citizenid_status', 'citizenid_status_updated', 'status']
  },
  gphone_notifications: {
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
  gphone_phone_call_log: {
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
  gphone_reports: {
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
  gphone_settings: {
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

/** A table's shape, reduced to the two things `gphoneschema apply` can add. */
interface TableShape {
  columns: string[];
  indexes: string[];
}

/**
 * What the declarations say every table looks like, right now.
 *
 * Derived rather than read out of `gphone.sql`, deliberately. The declaration is
 * the source of truth (AGENTS.md §8, "a schema change is written once, in the
 * declaration") and `gphone.sql` is regenerated from it — so a scan of the SQL
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

    for (const kind of ['column', 'index'] as const) {
      const key = kind === 'column' ? 'columns' : 'indexes';
      for (const name of now[key]) {
        if (!then[key].includes(name)) changes.push({ table, name, kind, direction: 'added' });
      }
      for (const name of then[key]) {
        if (!now[key].includes(name)) changes.push({ table, name, kind, direction: 'removed' });
      }
    }
  }
  return changes;
};

/**
 * The text of every inline code span in a markdown document, run together.
 *
 * The matcher reads code spans rather than the whole file because this changelog
 * writes every identifier in backticks — `gphone_media`, `gphone_music_range`,
 * `gphoneschema apply` — and a column called `url` or `role` would otherwise be
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
 * A change is announced when both its table and — for a column — the column
 * itself are named. Requiring the table as well is what keeps a generic column
 * name (`title`, `url`) from being satisfied by an unrelated line. An index is
 * held to the table only: index names are derived (`citizenid_status_updated`)
 * and reciting one at a server owner is noise, but "this table gained a key, so
 * run `gphoneschema apply`" is exactly what they need.
 *
 * Pure, so the probes below can drive it with input this repo does not have.
 */
const unannouncedSchemaChanges = (changes: SchemaChange[], changelog: string): string[] => {
  const spans = codeSpans(changelog);
  return changes
    .filter(({ table, name, kind }) =>
      kind === 'column' ? !(isNamed(table, spans) && isNamed(name, spans)) : !isNamed(table, spans)
    )
    .map(({ table, name, kind, direction }) => `${table}.${name} (${kind} ${direction})`);
};

/** A one-table schema for the probes, which need input this repo does not have. */
const shapes = (columns: string[], indexes: string[] = []) => ({
  gphone_widgets: { columns, indexes }
});

describe('changelog (MICA-72)', () => {
  it('announces every versioned migration', () => {
    const missing = unannounced(migrationIds(), changelogText());

    expect(
      missing,
      `a migration makes an update need \`gphoneschema apply\` — name it in ${CHANGELOG} ` +
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
        `a new column or key makes an update need \`gphoneschema apply\` on every existing ` +
          `install — name the table and the column in backticks in ${CHANGELOG}, under ` +
          `"Action required", so an owner reads it before pulling. A removal needs a ` +
          `versioned migration as well (AGENTS.md §8).`
      ).toEqual([]);
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
        { table: 'gphone_widgets', name: 'label', kind: 'column', direction: 'added' }
      ]);
    });

    it('sees a column they lost, and a key either way', () => {
      expect(schemaDrift(shapes(['id'], ['a']), shapes(['id', 'label'], ['b']))).toEqual([
        { table: 'gphone_widgets', name: 'label', kind: 'column', direction: 'removed' },
        { table: 'gphone_widgets', name: 'a', kind: 'index', direction: 'added' },
        { table: 'gphone_widgets', name: 'b', kind: 'index', direction: 'removed' }
      ]);
    });

    const added: SchemaChange = {
      table: 'gphone_widgets',
      name: 'label',
      kind: 'column',
      direction: 'added'
    };

    it('reports a column the changelog does not name', () => {
      expect(unannouncedSchemaChanges([added], '# Changelog\n\nNothing here.\n')).toEqual([
        'gphone_widgets.label (column added)'
      ]);
    });

    it('accepts one written down as prose plus identifiers', () => {
      const entry =
        '# Changelog\n\n- `gphone_widgets` gains a `label`; run `gphoneschema apply`.\n';

      expect(unannouncedSchemaChanges([added], entry)).toEqual([]);
    });

    it('is not satisfied by the words appearing outside a code span', () => {
      // The failure this prevents: an entry about something else that happens to
      // use the word, read as an announcement of this column.
      const prose = '# Changelog\n\nThe widgets table now shows a label on each row.\n';

      expect(unannouncedSchemaChanges([added], prose)).toEqual([
        'gphone_widgets.label (column added)'
      ]);
    });

    it('holds an index to its table rather than to its derived name', () => {
      const index: SchemaChange = {
        table: 'gphone_widgets',
        name: 'citizenid_status_updated',
        kind: 'index',
        direction: 'added'
      };

      expect(unannouncedSchemaChanges([index], '# Changelog\n\nNothing.\n')).toEqual([
        'gphone_widgets.citizenid_status_updated (index added)'
      ]);
      expect(
        unannouncedSchemaChanges([index], '# Changelog\n\n- `gphone_widgets` gains a key.\n')
      ).toEqual([]);
    });

    it('lets a migration id announce the column it drops', () => {
      const dropped: SchemaChange = {
        table: 'gphone_widgets',
        name: 'best_streak',
        kind: 'column',
        direction: 'removed'
      };
      const entry = '# Changelog\n\n- `0001_drop_gphone_widgets_best_streak` — run it.\n';

      expect(unannouncedSchemaChanges([dropped], entry)).toEqual([]);
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
