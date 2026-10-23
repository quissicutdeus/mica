// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Repository } from './Repository';
import {
  BLIND_INDEX_WIDTH,
  SEAL_KEY_COLUMN,
  SEAL_KEY_LENGTH,
  maxPlaintextChars,
  registerBlindIndex,
  registerEncryptedColumn,
  sealedLength,
  sealedLengthForChars
} from './contentCipher';
import { registerReportable, type ReportableDefinition } from './moderation';
import type { ReactableDefinition } from './reactions';
import { ServiceEndpoint, ServiceOptions } from './ServiceEndpoint';
import { registerServerOnlyColumns } from './replyShape';
import { ERASED } from './statuses';
import { assertSnapshotFits } from './versions';
import type { ServiceContract } from '@mica/shared/contract';
import { CITIZENID_MAX_LENGTH } from '@mica/shared/framework';
import { DEFAULT_DEVICE, isDeviceId, type DeviceId } from '@mica/shared/devices';

/**
 * One declaration per app, replacing the hand-written repository + controller pair.
 *
 * The declaration is the single source of truth for three things that were
 * previously maintained by hand and could silently diverge:
 *
 *   1. the table's DDL (see `toCreateTableSql`)
 *   2. the `columns` allowlist that guards SQL identifier interpolation (§2.9)
 *   3. the `clientWritable` set that `ServiceEndpoint` reduces payloads to
 *
 * (2) is only *safe* if it matches the real table, so deriving both from one
 * schema removes a class of bug rather than just saving keystrokes.
 *
 * Kept free of any import from `web/`, so a later move to a shared single-root
 * layout is a file move rather than a rewrite.
 */

export type ColumnType =
  | 'string'
  | 'text'
  | 'mediumtext'
  | 'int'
  | 'float'
  | 'bool'
  | 'json'
  | 'blob'
  | 'timestamp'
  | 'enum';

/**
 * The most a column of each type can actually hold, in characters.
 *
 * The schema has always known this and nothing ever read it: `length: 50` reached the DDL
 * and no further, so the generic write path would hand MySQL a 10,000-character value for a
 * `varchar(50)` and let the database decide. Which it does, badly — in non-strict mode it
 * **silently truncates**, so the row is written, the write reports success, and the data is
 * quietly wrong. In strict mode it errors, and the player sees "Unknown error".
 *
 * Checking here is close to free, because the declaration is the answer. `photos.image` is
 * `mediumtext` and legitimately holds a base64 screenshot, which is exactly why the cap is
 * derived per column rather than being one number invented for the whole payload.
 */
const MAX_LENGTH_BY_TYPE: Record<ColumnType, number | null> = {
  // varchar(n) — the declared length, resolved per column below.
  string: 255,
  text: 65535,
  mediumtext: 16777215,
  // Emitted as longtext. Capped at mediumtext rather than 4GB: nothing in the phone has a
  // use for a gigabyte of JSON, and an honest ceiling beats a theoretical one.
  json: 16777215,
  // Emitted as mediumblob.
  blob: 16777215,
  // Not length-limited; range- or value-checked instead.
  int: null,
  // No range check today (MICA-65's coordinates are the first `float` column, and
  // they are server-resolved from `playerCoords`, never client-writable — there is no
  // payload path `assertWritableValue` would need to bound). A future client-writable
  // float would need the same `INT_MIN`/`INT_MAX`-style pair `int` has, added then.
  float: null,
  bool: null,
  timestamp: null,
  enum: null
};

/**
 * The range a `defineService` `int` column can actually hold.
 *
 * `schemaSql.ts` always emits `int` as `int(11)` — a signed 32-bit MySQL `INT`, never
 * `UNSIGNED` and never `BIGINT` — so this pair is the one range every declared int column
 * has, not a per-column setting to derive. Before this, `assertWritableValue` only checked
 * that an int value was whole, so `Number.MAX_SAFE_INTEGER` written to an `int(11)` reached
 * MySQL, which in non-strict mode **silently clamps** to `INT_MAX` — the row is written,
 * the write reports success, and the stored value is not the one the client sent. Same
 * failure shape `MAX_LENGTH_BY_TYPE` exists to prevent for strings, just for numbers.
 */
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/** What the generic write path checks a value against, derived from one column's declaration. */
export interface ColumnRule {
  type: ColumnType;
  /**
   * Characters, for the text-ish types. Null when length is not the constraint. For a
   * `citizenId` column this is the widest width, for reading only: `Repository` asks
   * `ownerWidth.ts` for this server's — the framework is not known when a service is declared.
   */
  maxLength: number | null;
  /** The column holds a citizenid (MICA-289); its width is the owner table's. */
  citizenId: boolean;
  /** Permitted values, for `enum`. Null otherwise. */
  values: readonly string[] | null;
  /** Inclusive bounds for `int`. Null otherwise. */
  min: number | null;
  max: number | null;
  /** The column's own value check (`ColumnDef.accepts`), or null. */
  accepts: ((value: string) => boolean) | null;
  /** `ColumnDef.ascii`: a value with any non-ASCII character is refused. */
  ascii: boolean;
}

/** A foreign key onto another table. `players` is implied for `citizenid`. */
interface ColumnReference {
  table: string;
  column: string;
  /** Defaults to CASCADE, matching every existing mica FK. */
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
}

export interface ColumnDef {
  type: ColumnType;
  /** Max length for `string`. Ignored for other types. Default 255. */
  length?: number;
  /** Whether the column accepts NULL. Default true, except for `notNull` fields. */
  notNull?: boolean;
  /**
   * May a client payload write this column through the generic CRUD path?
   * Default true — a declared field is assumed to be app data the owner controls.
   */
  clientWritable?: boolean;
  /**
   * May a client filter on this column through the generic `get`? Default false.
   *
   * Orthogonal to `clientWritable`, and the two must not be reasoned about together: a
   * handle is searchable *and* unrenamable, which is one column holding both answers. It
   * answers to no access axis either — see `isClientFilterable`. It cannot be combined with
   * `private`, which `resolveAppSchema` refuses.
   */
  clientFilterable?: boolean;
  /** Index this column alongside citizenid. */
  index?: boolean;
  /**
   * SQL default. Omit for `DEFAULT NULL` on a nullable column. Needed for
   * faithfulness: `favorite tinyint(1) DEFAULT 0` reads very differently from
   * `DEFAULT NULL` once anything aggregates on it.
   */
  default?: string | number | boolean | null;
  /** Emit `DEFAULT CURRENT_TIMESTAMP`. Only meaningful for `timestamp`. */
  defaultNow?: boolean;
  /**
   * Emit `ON UPDATE CURRENT_TIMESTAMP`. Only meaningful for `timestamp`. Omitting it
   * on an `updated_at` column silently produces a table whose timestamp never moves.
   */
  onUpdateNow?: boolean;
  /**
   * Permitted values for `type: 'enum'`. A varchar stand-in would drop the
   * database-level constraint, so this is required when the type is `enum`.
   */
  values?: readonly string[];
  /**
   * Withhold this column from the generic **list** read's projection — `get`, on either
   * access axis.
   *
   * Two reasons a column earns this, and they are not the same reason:
   *
   * - **Secrecy**, on a public table: an app-specific field no other player may see.
   *   `citizenid` is excluded from every public projection automatically and does not need
   *   declaring — see `publicColumns`.
   * - **Weight**, on an owner-scoped one: a payload the list has no use for. `mica_media`
   *   is the case that forced this. Its `data` column holds a whole base64 photo, so an
   *   unprojected owner read shipped a few hundred kilobytes per row to draw a 123px tile
   *   (MICA-110), and the ownership predicate — which bounds *who* may read — does nothing
   *   about *how much*.
   *
   * Withheld from the **list**, which is not the same as secret. `findById` still selects
   * `*`, so a column private for weight stays reachable through an action that reads one
   * row and says so. A column private for secrecy must not be handed out by such an action;
   * that is the author's judgement, and the projection is what makes the list side of it
   * structural rather than remembered.
   *
   * Enforced in the SELECT rather than by filtering rows afterwards, so a
   * `repositoryFactory` override cannot re-add a field the query never named.
   */
  private?: boolean;
  /** Foreign key onto another table. */
  references?: ColumnReference;
  /**
   * Emit this column as `GENERATED ALWAYS AS (<expression>) VIRTUAL` instead of an
   * ordinary column (MICA-161).
   *
   * The expression may reference only literal SQL and other columns **on this same
   * table** — a generated column cannot look across a join, so it is no substitute for
   * one. `pair_key` on `mica_messages_conversations` is the first use: a normalised
   * `LEAST`/`GREATEST` over two citizenid columns on the same row, so it can carry a
   * unique index without a repair migration touching a single row of data.
   *
   * Implies not-client-writable regardless of `clientWritable` — MySQL/MariaDB reject an
   * explicit value for a virtual generated column outright, so `resolveAppSchema` throws
   * if `clientWritable: true` is declared alongside this rather than silently ignoring
   * the conflict. `default`/`defaultNow` make the same mistake from the other direction —
   * a generated column takes its value from the expression, never a literal — and are
   * rejected the same way.
   *
   * VIRTUAL rather than STORED/PERSISTENT: nothing here needs the value materialised on
   * disk, and both MySQL and MariaDB can still carry a secondary (including unique)
   * index on a VIRTUAL column.
   */
  generatedAs?: string;
  /**
   * For a generated column under a `uniqueAfterDelete: 'revive'` key: the column it copies
   * whenever a row holds the key (MICA-428). A revive looks for the caller's own `deleted` row
   * by the values the create names, and a create never names a generated column; a `deleted`
   * row's copy equals its base column, so the revive compares the base column in its place.
   *
   * Only alongside `generatedAs`, and only naming a column the table has. A status-aware key
   * (`CASE WHEN status <> 'erased' THEN citizenid ELSE NULL END`) is the one shape it is for.
   */
  reviveAs?: string;
  /**
   * This column holds a citizenid, so it is as wide as the owner key rather than `length`
   * (MICA-289): 50 where rows hang off qb's `players(citizenid)`, 60 where they hang off
   * ESX's `users(identifier)` or nothing. `schemaSql.ts` renders the width for the file it is
   * writing, and the write guard and the planner read the server's own (`ownerWidth.ts`).
   *
   * `type: 'string'` and no `length` — a length beside this would be a second answer to the
   * same question, and `resolveAppSchema` refuses the pair rather than pick one.
   */
  citizenId?: boolean;
  /**
   * The values a client payload may write, when neither `enum` nor a length can say it — a
   * column whose domain is open-ended but still shaped, such as a ringtone that is a built-in
   * id or an owner sound's `owner:<stem>` (MICA-256). Checked by the generic write path after
   * the length, against the value as a string; a refusal is a player-facing error naming the
   * column. Null is not passed to it: a nullable column clears the same way as any other.
   */
  accepts?: (value: string) => boolean;
  /**
   * Sealed at rest with the content key (MICA-165): the stored value is `$mc1$…` ciphertext
   * whenever a key is configured, and `lib/contentCipher.ts` opens it on every read path.
   *
   * `string` or `text` only. For a `string`, `length` keeps meaning what it always did — the
   * most **plaintext** characters a write may carry — and the table is emitted wide enough for
   * that plaintext's worst-case sealed form (`sealedLengthForChars`), which is what the DDL and
   * the planner see. A `text` has a fixed width, so its plaintext bound drops instead, to the
   * most characters whose sealed form still fits (`maxPlaintextChars`).
   *
   * Requires the service to declare `encryptionScope`. Refused beside `clientFilterable`,
   * `index`, `default`, `generatedAs` and `citizenId`: none of them means anything over
   * ciphertext, and each would read as working.
   *
   * On a `deviceOwned` table the value is bound to the row's phone, `device_id`, not its
   * `citizenid` (MICA-431): a handover rewrites `citizenid` on every row of the phone, and a
   * value bound to the character would stop opening there.
   */
  encrypted?: boolean;
  /**
   * The column only ever holds ASCII (MICA-431): a base64 image. Only beside `encrypted`, where
   * it sizes the plaintext bound at one byte a character rather than utf8mb4's worst case of
   * four — a 4 MiB photo seals well inside a `mediumtext`, and a four-byte bound would refuse it.
   * A write with any other character is refused, so the bound cannot be outrun.
   */
  ascii?: boolean;
  /**
   * The sealed value is looked up, or kept unique, by its value (MICA-432): a contact's number,
   * a join code, an alias. Adds a `<column>_index` column holding its blind index
   * (`lib/contentCipher.ts`, `BlindIndex`), which the generic write fills beside the sealed
   * value and every lookup matches by `blindIndexCandidates`. A unique key goes on the index
   * column — through a status-aware `generatedAs`, as before — never on the value.
   *
   * `scope` is what the value is unique within (`['device_id']` for a phone's contacts), bound
   * into the digest; `normalize` is what counts as the same value, the comparison the old
   * plaintext key's collation made. Only beside `encrypted`.
   */
  blindIndex?: {
    readonly scope?: readonly string[];
    readonly normalize?: (value: string) => string;
  };
  /**
   * Keep every value an edit replaces (MICA-430): before a write that changes this column, its
   * old value — sealed as stored, with the columns its seal binds — goes into the version ledger
   * in the same transaction (`lib/versions.ts`). Player content only: a column that is state, a
   * credential or a copy is left out, with its reason in `versionDecisions.test.ts`, which fails
   * on a sealed or player-writable text column that is neither.
   */
  versioned?: boolean;
}

/**
 * Refuse a `citizenId` column that also states a width or is not a string (MICA-289).
 * `where` names it for the message: a field, or a child table's column.
 */
const assertCitizenIdColumn = (id: string, where: string, def: ColumnDef): void => {
  if (!def.citizenId) return;
  if (def.type !== 'string' || def.length !== undefined) {
    throw new Error(
      `defineService('${id}'): ${where} is 'citizenId', which sets its type and width. ` +
        "Declare it as { type: 'string', citizenId: true } with no 'length'."
    );
  }
};

/**
 * A table an app owns besides its primary one — a join table, an attachment table.
 *
 * DDL-only: no repository is derived and no generic events are registered. It exists
 * so `pnpm generate:sql` emits a **complete** schema for the app. Without it, an app
 * with child tables would generate a file that looks authoritative while leaving
 * dangling foreign keys, which is worse than no file at all.
 *
 * Unlike the primary schema, nothing is implicit here: declare every column,
 * including `id` if you want one. Child tables in this codebase disagree about
 * whether they carry `status` or timestamps at all.
 */
export interface ChildTableDefinition {
  /** Full table name; no `mica_` prefix is added. */
  name: string;
  columns: Record<string, ColumnType | ColumnDef>;
  /** Emit `id int(11) NOT NULL AUTO_INCREMENT` + PRIMARY KEY. Defaults to true. */
  autoIncrementId?: boolean;
  indexes?: readonly IndexDefinition[];
  /**
   * Required when `indexes` declares a unique one (MICA-321), and only ever an opt-out: a child
   * table has no repository, so there is no generic `create` to revive through. The reason says
   * why its own writes cannot wedge — a hard delete frees the key, say.
   */
  uniqueAfterDelete?: { readonly optOut: string };
  /**
   * The child table's own `encryptionScope` (MICA-432), required when one of its columns is
   * `encrypted`, as the primary table's is. A child table has no repository, so its service
   * seals and opens it by hand (`sealRow`, `openRows`), and the encrypted-column guard holds it
   * to that. Bound to the row's `citizenid`, which a sealed child table must have and never
   * rewrite.
   */
  encryptionScope?: readonly string[];
}

/**
 * An index: either a bare column list (named by joining the columns) or an explicit
 * name. Name them when the derived one would be unwieldy or unclear — MySQL caps
 * index names at 64 characters, and a name is what shows up in EXPLAIN output.
 */
export type IndexDefinition =
  | readonly string[]
  | {
      readonly name: string;
      readonly columns: readonly string[];
      /**
       * Emit `UNIQUE KEY`. Use it when at-most-one-row is a real invariant rather than
       * a convention — a per-player state row, say. The application-level
       * find-then-write that would otherwise enforce it has a race the database does
       * not.
       */
      readonly unique?: boolean;
    };

/** See `ServiceDefinition.uniqueAfterDelete`. */
export type UniqueAfterDelete = 'revive' | { readonly optOut: string };

export interface ResolvedIndex {
  name: string;
  columns: readonly string[];
  unique: boolean;
}

export const normalizeIndex = (index: IndexDefinition): ResolvedIndex =>
  Array.isArray(index)
    ? { name: index.join('_'), columns: index, unique: false }
    : {
        name: (index as { name: string }).name,
        columns: (index as { columns: readonly string[] }).columns,
        unique: (index as { unique?: boolean }).unique === true
      };

/** `{ title: 'string' }` is shorthand for `{ title: { type: 'string' } }`. */
type ServiceSchema = Record<string, ColumnType | ColumnDef>;

/**
 * Who may read a row through the generic `get`, and who may write one.
 *
 * Two axes, because the old single `scope` conflated them and the code already knew it.
 * `Conversations.ts` says so in its own header: the row genuinely has an owner, and what
 * is shared is *visibility*. So Conversations declared `owner` and hand-wrote membership,
 * while Messages declared `shared` and hand-wrote membership — the same check, in two
 * different spellings, each free to drift from the other.
 */
interface AccessDefinition {
  /**
   * `owner`   — the caller's citizenid is forced into the WHERE. The default.
   * `public`  — any authenticated player may read every active row. A feed. **Requires
   *             `paging`**, which is the single most valuable rule in this file: it makes
   *             the unbounded `findAll` structurally unreachable from a public table
   *             rather than merely discouraged.
   * `members` — decided by `membership`, and the generic `get` is **not** registered:
   *             a membership read needs the parent id from the payload, which the
   *             generic filter path has no way to require. Supply a custom action and
   *             call `repo.isMember(...)`.
   */
  read: 'owner' | 'public' | 'members';
  /**
   * `owner`   — create/update/delete scoped to the row's citizenid.
   * `server`  — rows are written by the server, never the phone's owner. Nothing becomes
   *             client-writable and create/update are not registered; delete stays
   *             owner-scoped, because a server-authored row still belongs to one player.
   * `members` — the generic mutation path is not registered. Ownership is the wrong
   *             question and the parent id is not on the payload contract, so the app
   *             supplies actions that check `repo.isMember(...)` first.
   */
  write: 'owner' | 'server' | 'members';
  /** Required when either axis is `members`; rejected otherwise. */
  membership?: MembershipDefinition;
  /**
   * How long after creation an owner may still edit a row, in seconds. Omit for unlimited,
   * which is what every table did before this existed.
   *
   * For "fix a typo", not "rewrite history". Enforced as a predicate in the same `UPDATE`
   * rather than a check before it, so there is no window between deciding and writing — the
   * same reasoning membership uses. A UI that hides the Edit button is a courtesy; §2.9 says
   * the server is the boundary.
   *
   * `NOW()` and `created_at` are both the database's clock, so the comparison is immune to
   * server and client clock skew. That is the argument for doing it in SQL rather than TS.
   *
   * Applies to `update` only, never `delete`: you should be able to remove your own post
   * forever, and it would be easy to apply to both by accident.
   */
  editWindow?: number;
}

/**
 * How membership is decided, as data rather than as a SQL string.
 *
 * Never a caller-supplied fragment: §2.9's identifier allowlist has to extend across the
 * join, and a `where` string is precisely the hole that allowlist exists to close.
 *
 * `localKey` is what makes this reusable rather than a Conversations special case. A
 * conversation's membership is decided by its own `id`; a *message*'s is decided by its
 * `conversation_id`. Same join table, different local column — without `localKey`,
 * membership only ever works one hop from the parent row and Messages is inexpressible.
 */
interface MembershipDefinition {
  /** Join table holding the members. Not prefixed; give the full name. */
  table: string;
  /** Column on the join table holding the parent id. */
  foreignKey: string;
  /** Column on *this* table that `foreignKey` matches. Defaults to `id`. */
  localKey?: string;
  /** Column on the join table holding the member. Defaults to `citizenid`. */
  citizenColumn?: string;
  /**
   * The column on the join table naming the phone a member is on (MICA-282), so `isMember`
   * can narrow to one device. Declare it only when the table really carries one.
   */
  deviceColumn?: string;
  /** Membership is live only while this column IS NULL — `left_at`. */
  liveWhileNull?: string;
}

/**
 * Keyset pagination for a table whose row count is not bounded by one player.
 *
 * **Ordered by `id DESC`, and that is not configurable.** Four reasons, and they compound:
 *
 * `id` is the primary key, so in InnoDB it *is* the clustered index — `ORDER BY id DESC` is a
 * backward scan with no sort step and no secondary lookup. `ORDER BY created_at DESC` needs
 * an index of its own or it is a filesort over the whole table.
 *
 * The index it needs already exists. Every primary table emits `KEY status (status)`, and
 * InnoDB appends the primary key to every secondary index — so that key *is* physically
 * `(status, id)`, and `WHERE status = 'active' AND id < ? ORDER BY id DESC LIMIT ?` is a
 * plain range scan on something already shipped.
 *
 * The cursor is one column and needs no tie-break, because `id` is unique by construction.
 * A `created_at` cursor needs `(created_at < ? OR (created_at = ? AND id < ?))`: the column
 * is second-resolution, two rows in the same second are routine, and the naive form silently
 * drops one at every page boundary — a bug you find in production and never in a test.
 *
 * And `id` never changes, so editing a row cannot reorder a feed under a reader mid-scroll.
 * A configurable `orderBy` would hand all four of those back.
 *
 * Not offset paging, either: a feed takes inserts at the head, so `OFFSET N` skips and
 * duplicates rows across pages, and MySQL walks N rows to throw them away. Nothing in the
 * phone has a jump-to-page control to pay for that with.
 *
 * The one caveat, noted rather than designed around: `AUTO_INCREMENT` is monotonic per table,
 * but under `innodb_autoinc_lock_mode = 2` with *concurrent multi-row* inserts ids can be
 * assigned out of commit order, so a paginating reader could in principle skip a row. The
 * phone only ever inserts single rows, which serialize. `created_at` has the same exposure
 * and worse, since its values actually collide.
 */
interface PagingDefinition {
  /** Rows per page when the client does not ask. Default 50. */
  pageSize?: number;
  /** Ceiling on what a client may ask for. Default 100. */
  maxPageSize?: number;
}

interface ResolvedPaging {
  pageSize: number;
  maxPageSize: number;
}

export interface ResolvedMembership {
  table: string;
  foreignKey: string;
  localKey: string;
  citizenColumn: string;
  /** The membership table's device column, or null when membership belongs to the citizen alone. */
  deviceColumn: string | null;
  liveWhileNull: string | null;
}

export interface ServiceDefinition<C extends ServiceContract = ServiceContract> {
  /** Matches the web module's manifest id. */
  id: string;
  /**
   * The one app this service belongs to, when no other app reaches it (MICA-234).
   *
   * An owner disabling that app with `mica_disabled_apps` then refuses every event here, custom
   * and generic. Not always `id`: Glimpse's comments are `glimpse_comments`. Declared here
   * rather than in `lib/ownerConfig.ts` so core never names an app. Leave it off for a service
   * several apps share — see `ServiceOptions.app`.
   */
  app?: string;
  /**
   * This service's custom actions, declared once in `shared/contracts/<id>.ts`.
   *
   * The CRUD actions `ServiceEndpoint` derives from `schema` below are **not** in it and must
   * not be — the write allowlist and the per-column rules already validate those. A contract
   * covers the actions a service registers by hand, which are the ones that had no rule at all
   * until one was declared, including a hand-written `create` that replaced a disabled generic
   * one.
   *
   * Its `id` has to match this one; two names for one service is the drift the whole
   * declaration exists to remove.
   */
  contract?: C;
  /** Defaults to `mica_<id>`. */
  table?: string;
  /**
   * Make this service's rows reportable, and say how the review queue describes one.
   *
   * Declared here rather than listed in `lib/moderation.ts` so that core never has to
   * name an app's tables — an add-on can opt in without editing anything it does not own.
   * `previewColumn` has to exist on the table alongside `citizenid` and `status`, which
   * `summariseTarget` also selects.
   */
  reportable?: ReportableDefinition;
  /**
   * Make this service's rows reactable — `mica_account_reactions` may target them — and carry
   * the whole rule: who may react to a row (`canReact`), whose reactions a viewer may read
   * (`visibleTo`), and, when it is not the open palette, which emoji (`emoji`).
   *
   * Same reason as `reportable`: declared here so core never has to name an add-on's table
   * (MICA-391). `services/Accounts.ts` reads the rule back through `lib/reactions.ts` at call
   * time. Both functions are required: a reactable table with no rule would have to either
   * refuse everything or accept everything, and neither is a decision to make by omission.
   */
  reactable?: ReactableDefinition;
  /**
   * The rows follow the phone, not the character (MICA-282).
   *
   * Injects a nullable `device_id` column and a `device_id` index, and makes every generic
   * action scope by the caller's active phone as well as their citizenid — the phone id is
   * resolved by `ServiceEndpoint` from the item in the caller's own inventory and handed to
   * custom handlers as their sixth argument. A row's `citizenid` names whoever holds the phone
   * now, and moves with it: `services/Devices.ts` calls `transferDeviceRows` on every table
   * with a `device_id` column when a phone changes hands. Declare it for what belongs to the
   * *device* — contacts, notes, media, the lock screen — and never for what belongs to the
   * *person*, or a stolen phone hands over somebody's money. `docs/schema-and-services.md`
   * has the split, table by table.
   */
  deviceOwned?: boolean;
  /**
   * The devices whose requests this service answers (MICA-264). Defaults to `['phone']`; a
   * request naming any other device is refused at the endpoint, before the player lookup.
   *
   * List `'tablet'` only for what a tablet should reach. On a `deviceOwned` service the tablet
   * then has rows of its own, keyed on its own id — Notes, Settings, the lock screen — never
   * the phone's. On any other service it reaches the citizen's rows, the same ones the phone
   * does — Mail. A service that is the phone's by nature (contacts, the call log, the battery)
   * keeps the default. The app manifest's `devices` is what shows the icon; this is what the
   * server answers, and the two should agree.
   */
  devices?: readonly DeviceId[];
  /**
   * The thread an encrypted column's value belongs to (MICA-165): this table's own columns,
   * bound after `citizenid` into the authenticated data of every `encrypted: true` column, so a
   * value copied into another conversation — or between another pair of DM accounts — does
   * not open.
   *
   * **Required** when any column is `encrypted`, and `[]` is a real answer (a mail row is its
   * own scope). A column named here must never change once the row is written: rewriting one
   * would leave the ciphertext bound to a thread the row is no longer in, so a client-writable
   * column is refused. Not the row id, which does not exist until the insert that stores the
   * ciphertext.
   */
  encryptionScope?: readonly string[];
  /**
   * Bind the encrypted columns to the **row** rather than to `citizenid` (MICA-432), for a table
   * whose `citizenid` passes to another character — a Dark Chat channel's owner, a thread's
   * creator. Adds a `seal_key` column, drawn for each row when it is written and never
   * rewritten, which the values are sealed to. Not on a `deviceOwned` table, which is bound to
   * its phone.
   */
  encryptionBinding?: 'row';
  /** Defaults to `{ read: 'owner', write: 'owner' }`. */
  access?: AccessDefinition;
  /** Keyset paging on the generic read. **Required** when `access.read` is `public`. */
  paging?: PagingDefinition;
  schema: ServiceSchema;
  /** Values the `status` column accepts. Defaults to active/deleted. */
  statuses?: readonly string[];
  /**
   * Composite indexes, each a full ordered column list — e.g.
   * `[['citizenid', 'status', 'updated_at']]`. Needed because a per-column `index`
   * flag cannot express the multi-column indexes the existing tables rely on, and a
   * declaration that cannot express them would silently drop them on migration.
   */
  indexes?: readonly IndexDefinition[];
  /**
   * What happens to a unique key a soft-deleted row still holds (MICA-321). **Required** when
   * `indexes` declares a unique one — `uniqueKeyDecisions.test.ts` fails a declaration without
   * it — and refused when there is none.
   *
   * `delete` is soft, so a deleted row keeps every unique key it is under, and creating the same
   * row again is a duplicate-key error the player sees as the generic failure (MICA-318).
   *
   * - `'revive'` — `create` brings back the caller's own deleted row under the conflicting key
   *   instead of inserting: same `citizenid`, and the same `device_id` on a device-owned table,
   *   never another owner's. The revived row is written as the insert would have written it
   *   and keeps only its id. See `Repository.reviveOwnDeleted`.
   * - `{ optOut: '<reason>' }` — `create` stays a plain insert and the key keeps refusing, for
   *   the reason given: a handle taken forever by design, a key that is NULL on a deleted row,
   *   a table that upserts and hard-deletes. The reason is the record of the decision, so it
   *   says what in this service's own code makes it safe or intended.
   */
  uniqueAfterDelete?: UniqueAfterDelete;
  /**
   * Other tables this app owns — join tables, attachment tables. DDL-only, emitted
   * after the primary table so the generated schema is complete and its foreign keys
   * resolve.
   */
  childTables?: readonly ChildTableDefinition[];
  /** Passed through to ServiceEndpoint — e.g. `{ disableUpdate: true }`. */
  options?: ServiceOptions<C>;
  /**
   * Escape hatch for apps that need custom read shaping — e.g. coercing a blob
   * column to a string before it crosses NUI. Subclass `SchemaRepository` so the
   * result still inherits the `columns` allowlist and the ownership scoping;
   * overriding a method is additive, not a way around §2.9.
   */
  repositoryFactory?: (resolved: ResolvedService) => Repository<any>;
}

/** Columns every micaOS table carries. Declared by the framework, not by an app. */
const IMPLICIT_COLUMNS = ['id', 'citizenid', 'status', 'created_at', 'updated_at'] as const;

const DEFAULT_STATUSES = ['active', 'deleted'] as const;

const normalizeColumn = (spec: ColumnType | ColumnDef): ColumnDef =>
  typeof spec === 'string' ? { type: spec } : spec;

/**
 * A field is client-writable unless it opts out. Only an owner-write table has a generic
 * client write path at all, so `server` and `members` opt every field out wholesale.
 */
const isClientWritable = (def: ColumnDef, write: AccessDefinition['write']): boolean =>
  write === 'owner' && def.clientWritable !== false && !def.generatedAs;

/**
 * A field is filterable if it opted in, and **writability has nothing to do with it**.
 *
 * These two were one predicate until MICA-137, and the conflation was not academic:
 * `handle` on `mica_accounts` is `clientWritable: false` precisely because a handle must
 * never be renamed, and `clientFilterable: true` precisely because looking an account up by
 * handle is the only way to open a profile. Coupling them dropped `handle` from the filter
 * allowlist, `sanitizeFilter` returned `{}`, and the paged public read answered a profile
 * lookup with whatever row happened to be newest. An identity column that is searchable and
 * immutable is not an edge case — it is the normal shape of an identity column.
 *
 * It answers to no access axis either, and the temptation is `read: 'members'` — which
 * registers no generic `get`, so its filterable set is never consumed. Zeroing it here would
 * be the same mistake in a nicer place: one derivation deciding two things, and a declared
 * flag quietly not meaning what it says. Reachability is `accessLockdown`'s job, one
 * `disableGet` away, and it does it in exactly one place.
 *
 * Two columns that must never be filterable are refused elsewhere, and neither needs a clause
 * here. `citizenid` and `status` are `IMPLICIT_COLUMNS` names, so the field loop **throws** on
 * a schema that so much as declares one — no derivation in this function could reach them,
 * which was as true before this ticket as after. (`Repository.NEVER_CLIENT_FILTERABLE` catches
 * the hand-written repositories that never pass through here.) And `private` is refused by the
 * same loop when paired with this flag, so a column cannot be filterable-but-unreturnable.
 */
const isClientFilterable = (def: ColumnDef): boolean => def.clientFilterable === true;

export interface ResolvedService {
  id: string;
  table: string;
  /** See `ServiceDefinition.deviceOwned`. */
  deviceOwned: boolean;
  /** See `ServiceDefinition.devices`; `['phone']` when the declaration names none. */
  devices: readonly DeviceId[];
  access: Required<Pick<AccessDefinition, 'read' | 'write'>>;
  /** Resolved defaults filled in; null unless an axis is `members`. */
  membership: ResolvedMembership | null;
  /** Seconds an owner may still edit for; null for unlimited. */
  editWindow: number | null;
  /** Resolved defaults filled in; null unless the service declared `paging`. */
  paging: ResolvedPaging | null;
  /** Per-column write validation, derived from the schema. Keyed by column name. */
  columnRules: Record<string, ColumnRule>;
  /**
   * What a public read is allowed to select.
   *
   * `citizenid` is always absent, and that is the load-bearing part rather than tidiness.
   * A public table is the first thing here that returns rows a player does not own, and once
   * one player can hold several accounts, the owner's citizenid is a **de-anonymisation
   * vector**: it correlates two deliberately-separate identities back to one person, which is
   * the entire thing an alt account exists to prevent. No public reader has ever needed it —
   * a client establishes "this is mine" from the account ids it already holds, and the server
   * authorizes writes from the session either way.
   */
  publicColumns: string[];
  /**
   * What the generic owner-scoped list read selects — every column that is not `private`.
   *
   * Sibling of `publicColumns` and deliberately not the same list: an owner reading their
   * own rows has every business seeing their `citizenid`, which no public reader does. The
   * only thing the two agree on is that a `private` column is in neither.
   */
  listColumns: string[];
  statuses: readonly string[];
  /** Declared fields only, in declaration order — implicit columns excluded. */
  fields: { name: string; def: ColumnDef }[];
  columns: string[];
  /** What a payload may set through the generic write path. See `isClientWritable`. */
  clientWritable: string[];
  /**
   * What a payload may narrow the generic `get` by. Independent of `clientWritable` — see
   * `isClientFilterable` for why the two were one predicate and should never have been.
   */
  clientFilterable: string[];
  indexes: readonly ResolvedIndex[];
  /** The declared decision; null when the declaration made none. */
  uniqueAfterDelete: UniqueAfterDelete | null;
  childTables: readonly ChildTableDefinition[];
  /** The `encrypted: true` columns, in declaration order (MICA-165). */
  encryptedColumns: string[];
  /** The `versioned: true` columns, in declaration order (MICA-430). */
  versioned: string[];
  /** `ServiceDefinition.encryptionScope`; `[]` when nothing is encrypted. */
  encryptionScope: string[];
  /** What the encrypted columns are bound to (MICA-431, MICA-432). */
  encryptionBinding: 'citizen' | 'device' | 'row';
  /** The sealed columns looked up by value, and their index columns (MICA-432). */
  blindIndexes: ResolvedBlindIndex[];
  /** Child tables with sealed columns, which the service seals and opens by hand (MICA-432). */
  childEncryption: ResolvedChildEncryption[];
  /** `ServiceDefinition.reactable`; null when the declaration did not opt in. */
  reactable: ReactableDefinition | null;
}

/**
 * The widest a `varchar` of utf8mb4 may be: 65,535 bytes a row, four a character. An encrypted
 * `string` whose sealed form would pass it has to be a `text` instead.
 */
const MAX_VARCHAR_CHARS = 16383;

/** An encrypted `string`'s width once sealed: its plaintext bound, at its bytes a character. */
const storedWidth = (def: ColumnDef): number =>
  def.ascii === true ? sealedLength(def.length ?? 255) : sealedLengthForChars(def.length ?? 255);

/**
 * The most bytes a column's value can take, for sizing a version snapshot (MICA-430); null for
 * one with no useful bound. A sealed `string` is its stored width; a `text` is its capacity.
 */
const valueBytes = (def: ColumnDef): number | null => {
  switch (def.type) {
    case 'string':
      return def.encrypted ? storedWidth(def) : (def.length ?? 255) * 4;
    case 'text':
      return 65_535;
    case 'mediumtext':
      return null;
    case 'enum':
      return Math.max(1, ...(def.values ?? []).map((value) => value.length));
    default:
      return 32;
  }
};

/** The most a context column (an owner, a phone, a seal key, a scope id) takes in a snapshot. */
const CONTEXT_BYTES = 255;

/**
 * The versioned columns of one table, checked (MICA-430): never a generated one, which holds
 * nothing to keep, and never so many or so wide that a snapshot could outgrow the ledger.
 */
const versionedColumnsOf = (
  id: string,
  table: string,
  fields: readonly { name: string; def: ColumnDef }[]
): string[] => {
  const versioned = fields.filter((field) => field.def.versioned === true);
  for (const { name, def } of versioned) {
    if (def.generatedAs) {
      throw new Error(
        `defineService('${id}'): '${name}' is 'versioned' but generated; it holds no value of ` +
          'its own to keep.'
      );
    }
  }
  if (versioned.length === 0) return [];
  assertSnapshotFits(table, {
    ...Object.fromEntries(versioned.map(({ name, def }) => [name, valueBytes(def)])),
    // The owner, a phone, a seal key and the scope a sealed value binds, at most.
    '(context)': CONTEXT_BYTES * 8
  });
  return versioned.map(({ name }) => name);
};

/** What an `encrypted: true` column may not also be (MICA-165). */
const assertEncryptedColumn = (id: string, name: string, def: ColumnDef): void => {
  if (def.ascii === true && !def.encrypted) {
    throw new Error(
      `defineService('${id}'): '${name}' is 'ascii' but not 'encrypted'. It sizes a sealed ` +
        'bound and means nothing on its own.'
    );
  }
  if (!def.encrypted) return;
  const where = `defineService('${id}'): '${name}' is 'encrypted'`;
  if (def.type !== 'string' && def.type !== 'text' && def.type !== 'mediumtext') {
    throw new Error(`${where} but is a '${def.type}'. Only text is sealed.`);
  }
  const conflict = (
    [
      ['clientFilterable', def.clientFilterable === true],
      ['index', def.index === true],
      ['default', def.default !== undefined || def.defaultNow === true],
      ['generatedAs', Boolean(def.generatedAs)],
      ['citizenId', def.citizenId === true]
    ] as const
  ).find(([, present]) => present);
  if (conflict) {
    throw new Error(
      `${where} and '${conflict[0]}', which means nothing over ciphertext: every sealed ` +
        'value is different bytes, even for the same text.'
    );
  }
  if (def.type === 'string' && storedWidth(def) > MAX_VARCHAR_CHARS) {
    throw new Error(
      `${where}, and ${def.length ?? 255} characters seal to more than a varchar holds. ` +
        "Declare it 'text'."
    );
  }
};

/** A sealed column's blind index, as `defineService` resolved it (MICA-432). */
export interface ResolvedBlindIndex {
  column: string;
  index: string;
  scope: readonly string[];
  normalize: (value: string) => string;
}

const sameValue = (value: string): string => value;

/**
 * Add a `<column>_index` field beside every `blindIndex` column, and answer what to register.
 * The index column is never client-writable and never read back: it is the server's to fill
 * and to match on, and it says nothing a reader is owed.
 */
const addBlindIndexColumns = (
  id: string,
  fields: { name: string; def: ColumnDef }[],
  columns: readonly string[]
): ResolvedBlindIndex[] => {
  const out: ResolvedBlindIndex[] = [];
  // Filtered first: the loop splices an index field in beside each, so it walks this list.
  const indexed = fields.filter((f) => f.def.blindIndex !== undefined);
  for (const { name, def } of indexed) {
    if (!def.blindIndex) continue;
    if (!def.encrypted) {
      throw new Error(
        `defineService('${id}'): '${name}' has a 'blindIndex' but is not 'encrypted': a ` +
          'plaintext column is looked up as it is.'
      );
    }
    const index = `${name}_index`;
    if (columns.includes(index)) {
      throw new Error(`defineService('${id}'): '${index}' is supplied by '${name}'s blindIndex.`);
    }
    const scope = [...(def.blindIndex.scope ?? [])];
    for (const column of scope) {
      if (!columns.includes(column) || column === name) {
        throw new Error(
          `defineService('${id}'): '${name}'s blindIndex is scoped by '${column}', which is ` +
            'not another column of the table.'
        );
      }
      if (fields.some((f) => f.name === column && f.def.encrypted === true)) {
        throw new Error(
          `defineService('${id}'): '${name}'s blindIndex is scoped by '${column}', an ` +
            'encrypted column: equal scopes would not compare equal.'
        );
      }
    }
    // Right after the value, so a generated key built on it — `phone_key`, `alias_key`, which
    // the declarations put later — reads a column defined before it, as MariaDB needs.
    fields.splice(fields.findIndex((f) => f.name === name) + 1, 0, {
      name: index,
      def: { type: 'string', length: BLIND_INDEX_WIDTH, clientWritable: false, private: true }
    });
    out.push({ column: name, index, scope, normalize: def.blindIndex.normalize ?? sameValue });
  }
  return out;
};

/**
 * A child table with sealed columns (MICA-432), resolved: the table as the DDL emits it — each
 * sealed `string` as wide as its sealed form, a `<column>_index` beside each blind-indexed one
 * — and what to register.
 */
export interface ResolvedChildEncryption {
  table: string;
  columns: string[];
  scope: string[];
  hasUpdatedAt: boolean;
  blindIndexes: ResolvedBlindIndex[];
}

const resolveChildEncryption = (
  id: string,
  child: ChildTableDefinition
): { child: ChildTableDefinition; encryption: ResolvedChildEncryption | null } => {
  const defs = Object.entries(child.columns).map(([name, spec]) => ({
    name,
    def: normalizeColumn(spec)
  }));
  const sealed = defs.filter((f) => f.def.encrypted === true).map((f) => f.name);
  if (sealed.length === 0) {
    if (child.encryptionScope !== undefined) {
      throw new Error(
        `defineService('${id}'): child table '${child.name}' declares 'encryptionScope' but ` +
          "no column is 'encrypted'."
      );
    }
    return { child, encryption: null };
  }
  const where = `defineService('${id}'): child table '${child.name}'`;
  if (child.encryptionScope === undefined) {
    throw new Error(
      `${where} has an 'encrypted' column but no 'encryptionScope'. Name the columns that say ` +
        'which thread a row is in, or [] when the row is its own.'
    );
  }
  if (!defs.some((f) => f.name === 'citizenid')) {
    throw new Error(
      `${where} has an 'encrypted' column and no 'citizenid', which its values are bound to.`
    );
  }
  for (const f of defs) assertEncryptedColumn(id, `${child.name}.${f.name}`, f.def);
  const names = defs.map((f) => f.name);
  for (const column of child.encryptionScope) {
    if (!names.includes(column) || sealed.includes(column) || column === 'citizenid') {
      throw new Error(`${where}: encryptionScope names '${column}', which it cannot bind.`);
    }
  }
  const fields = defs.map((f) =>
    f.def.encrypted && f.def.type === 'string'
      ? { name: f.name, def: { ...f.def, length: storedWidth(f.def) } }
      : f
  );
  const blindIndexes = addBlindIndexColumns(id, fields, names);
  return {
    child: { ...child, columns: Object.fromEntries(fields.map((f) => [f.name, f.def])) },
    encryption: {
      table: child.name,
      columns: sealed,
      scope: [...child.encryptionScope],
      hasUpdatedAt: names.includes('updated_at'),
      blindIndexes
    }
  };
};

/** Check `encryptionScope` against the resolved columns. `[]` when nothing is encrypted. */
const resolveEncryptionScope = (
  definition: ServiceDefinition,
  columns: readonly string[],
  fields: readonly { name: string; def: ColumnDef }[],
  encryptedColumns: readonly string[]
): string[] => {
  const { id } = definition;
  const scope = definition.encryptionScope;
  if (encryptedColumns.length === 0) {
    if (scope !== undefined) {
      throw new Error(
        `defineService('${id}'): 'encryptionScope' is declared but no column is 'encrypted'.`
      );
    }
    return [];
  }
  if (scope === undefined) {
    throw new Error(
      `defineService('${id}'): '${encryptedColumns[0]}' is 'encrypted' but the service ` +
        "declares no 'encryptionScope'. Name the columns that say which thread a row is in, " +
        'or [] when the row alone is the scope.'
    );
  }
  const write = definition.access?.write ?? 'owner';
  for (const column of scope) {
    if (
      !columns.includes(column) ||
      column === 'citizenid' ||
      column === 'device_id' ||
      column === 'id'
    ) {
      throw new Error(
        `defineService('${id}'): encryptionScope names '${column}', which it cannot bind: ` +
          "'citizenid' and 'device_id' are the owner the binding already names, 'id' does " +
          'not exist before the insert, and anything else has to be a column of this table.'
      );
    }
    if (encryptedColumns.includes(column)) {
      throw new Error(
        `defineService('${id}'): encryptionScope names '${column}', an encrypted column.`
      );
    }
    const def = fields.find((f) => f.name === column)?.def;
    if (def && isClientWritable(def, write)) {
      throw new Error(
        `defineService('${id}'): encryptionScope names '${column}', which a client may ` +
          "rewrite, and a sealed value bound to it would stop opening. Mark it 'clientWritable: " +
          "false'."
      );
    }
  }
  if (new Set(scope).size !== scope.length) {
    throw new Error(`defineService('${id}'): encryptionScope repeats a column.`);
  }
  return [...scope];
};

/**
 * Expand a declaration into the concrete lists the runtime needs. Pure — no
 * database, no event registration — so it is cheap to test and to feed to codegen.
 */
/** An opt-out's reason: a sentence, not a placeholder. */
const assertOptOutReason = (where: string, decision: unknown): void => {
  const reason = (decision as { optOut?: unknown } | null)?.optOut;
  if (typeof reason !== 'string' || reason.trim().length < 10) {
    throw new Error(
      `${where}: 'uniqueAfterDelete' must be 'revive' or { optOut: '<reason>' }, and the ` +
        'reason has to say why this table may keep refusing a re-create.'
    );
  }
};

/**
 * Check a primary table's `uniqueAfterDelete` against its indexes (MICA-321).
 *
 * A decision with no unique index to decide for is refused: it would read as a table that
 * revives, or one somebody thought about, when neither is true. A missing decision is not
 * refused here — `uniqueKeyDecisions.test.ts` fails it over every declared service, so an
 * add-on declaring through this function is not broken at start by a rule it never saw.
 */
const resolveUniqueAfterDelete = (
  id: string,
  definition: ServiceDefinition,
  indexes: readonly ResolvedIndex[],
  fields: readonly { name: string; def: ColumnDef }[]
): UniqueAfterDelete | null => {
  const decision = definition.uniqueAfterDelete;
  if (decision === undefined) return null;
  const where = `defineService('${id}')`;
  const unique = indexes.filter((index) => index.unique);
  if (unique.length === 0) {
    throw new Error(
      `${where}: 'uniqueAfterDelete' is declared but the table has no unique index to decide for.`
    );
  }
  if (decision !== 'revive') {
    assertOptOutReason(where, decision);
    return { optOut: decision.optOut };
  }
  /**
   * A sealed value is different every time it is written, so a key over one never matches the
   * value a create carries, and the revive would read as working while never finding a row.
   */
  for (const index of unique) {
    const sealed = index.columns.find((column) =>
      fields.some((f) => f.name === column && f.def.encrypted === true)
    );
    if (sealed) {
      throw new Error(
        `${where}: 'uniqueAfterDelete: revive' over '${index.name}', which names the encrypted ` +
          `column '${sealed}'. Ciphertext never compares equal to a new value.`
      );
    }
  }
  /**
   * A revive writes `= DEFAULT` to every declared column the create leaves out, so a NOT NULL
   * column with no default would take MariaDB's implicit `''` or `0` — a value the insert it
   * replaces would have refused outright. Exempt only a column in **every** unique key: a revive
   * needs one key fully named, so such a column is always written and never defaulted.
   */
  const inEveryKey = (column: string): boolean =>
    unique.every((index) => index.columns.includes(column));
  const implicit = fields.find(
    ({ name, def }) =>
      def.notNull === true &&
      def.default === undefined &&
      !def.defaultNow &&
      !def.generatedAs &&
      !inEveryKey(name)
  );
  if (implicit) {
    throw new Error(
      `${where}: 'uniqueAfterDelete: revive' with '${implicit.name}', which is NOT NULL with no ` +
        "default. A revive that leaves it out would write MariaDB's implicit '' or 0 where an " +
        'insert is refused. Give it a default, or put it in every unique key.'
    );
  }
  return 'revive';
};

/**
 * A declaration's `devices`, checked once at declaration time: every entry a device in
 * `shared/devices.ts`, none twice, and at least one — an empty list would register a service
 * no request can reach, which is a declaration mistake rather than a policy.
 */
const resolveDevices = (id: string, devices: readonly DeviceId[] | undefined): DeviceId[] => {
  if (devices === undefined) return [DEFAULT_DEVICE];
  if (devices.length === 0) {
    throw new Error(`defineService('${id}'): 'devices' is empty, so no request could reach it.`);
  }
  for (const device of devices) {
    if (!isDeviceId(device)) {
      throw new Error(`defineService('${id}'): '${String(device)}' in 'devices' is not a device.`);
    }
  }
  if (new Set(devices).size !== devices.length) {
    throw new Error(`defineService('${id}'): 'devices' names a device twice.`);
  }
  return [...devices];
};

/** A child table's `uniqueAfterDelete`: an opt-out, and only beside a unique index. */
const assertChildUniqueAfterDelete = (id: string, child: ChildTableDefinition): void => {
  const decision = child.uniqueAfterDelete;
  if (decision === undefined) return;
  const where = `defineService('${id}'): child table '${child.name}'`;
  if (!(child.indexes ?? []).map(normalizeIndex).some((index) => index.unique)) {
    throw new Error(
      `${where}: 'uniqueAfterDelete' is declared but the table has no unique index to decide for.`
    );
  }
  if ((decision as unknown) === 'revive') {
    throw new Error(
      `${where}: 'uniqueAfterDelete' can only opt out. A child table has no repository, so ` +
        'there is no create to revive through.'
    );
  }
  assertOptOutReason(where, decision);
};

/**
 * A `reactable` declaration, checked here rather than at the first reaction. An empty `emoji`
 * list would refuse every reaction while reading as an opt-in.
 */
const resolveReactable = (
  id: string,
  reactable: ReactableDefinition | undefined
): ReactableDefinition | null => {
  if (!reactable) return null;
  if (reactable.emoji && reactable.emoji.length === 0) {
    throw new Error(
      `defineService('${id}'): 'reactable.emoji' is empty, which refuses every reaction. ` +
        'Leave it out for the open palette.'
    );
  }
  return reactable;
};

export function resolveAppSchema(definition: ServiceDefinition): ResolvedService {
  const { id, schema } = definition;

  if (!id || typeof id !== 'string') {
    throw new Error("defineService: 'id' is required and must be a string.");
  }
  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) {
    throw new Error(`defineService('${id}'): 'schema' must declare at least one field.`);
  }

  const access = {
    read: definition.access?.read ?? 'owner',
    write: definition.access?.write ?? 'owner'
  } as const;
  const usesMembership = access.read === 'members' || access.write === 'members';
  const rawMembership = definition.access?.membership;

  if (usesMembership && !rawMembership) {
    throw new Error(
      `defineService('${id}'): access declares 'members' but no 'membership'. Membership has ` +
        'to name the join table, or there is nothing to check against.'
    );
  }
  /**
   * Deliberately no "declared but unused" error here.
   *
   * Conversations is the case that rules it out: its generic path is genuinely
   * owner-scoped — renaming rides the ownership-scoped `update`, so only the creator can
   * do it — while `read`, `archive` and `delete` are custom actions that each have to
   * check *participation*. So it declares `membership` with neither axis set to `members`,
   * and `repo.isMember` is consumed by its own handlers rather than by the generic path.
   * Rejecting that would push it back to a hand-written predicate, which is the
   * duplication this whole declaration exists to remove.
   */

  const paging: ResolvedPaging | null = definition.paging
    ? {
        pageSize: definition.paging.pageSize ?? 50,
        maxPageSize: definition.paging.maxPageSize ?? 100
      }
    : null;

  /**
   * The rule that makes the unbounded read unreachable rather than merely discouraged.
   *
   * `Repository.findAll` returns every matching row, and until now the only thing bounding
   * that was the citizenid predicate — one player's notes, one player's photos. A public
   * table has no such bound, so it has to declare how it is paged before it can be read at
   * all. Enforced here, at declaration time, because the alternative is finding out when a
   * feed reaches a hundred thousand rows.
   */
  if (access.read === 'public' && !paging) {
    throw new Error(
      `defineService('${id}'): access.read is 'public' but no 'paging' is declared. A public ` +
        'read has no per-player bound, so an unpaged one returns the whole table.'
    );
  }

  if (paging && (paging.pageSize < 1 || paging.maxPageSize < paging.pageSize)) {
    throw new Error(
      `defineService('${id}'): paging needs pageSize >= 1 and maxPageSize >= pageSize.`
    );
  }

  const editWindow = definition.access?.editWindow ?? null;
  if (editWindow !== null && (!Number.isInteger(editWindow) || editWindow <= 0)) {
    throw new Error(
      `defineService('${id}'): access.editWindow must be a positive whole number of seconds.`
    );
  }
  if (editWindow !== null && access.write !== 'owner') {
    throw new Error(
      `defineService('${id}'): access.editWindow only applies to 'owner' writes — nothing ` +
        'else goes through the ownership-scoped update it constrains.'
    );
  }

  const table = definition.table ?? `mica_${id}`;

  let membership: ResolvedMembership | null = null;
  if (rawMembership) {
    const identifiers: [string, string | undefined][] = [
      ['table', rawMembership.table],
      ['foreignKey', rawMembership.foreignKey],
      ['localKey', rawMembership.localKey],
      ['citizenColumn', rawMembership.citizenColumn],
      ['deviceColumn', rawMembership.deviceColumn],
      ['liveWhileNull', rawMembership.liveWhileNull]
    ];
    for (const [field, value] of identifiers) {
      // Every one of these is interpolated into SQL, and MySQL cannot parameterize an
      // identifier. Same rule as the column allowlist, applied across the join.
      if (value !== undefined && !/^[a-z][a-z0-9_]*$/.test(value)) {
        throw new Error(
          `defineService('${id}'): membership.${field} '${value}' must be lower_snake_case — ` +
            'it becomes a SQL identifier.'
        );
      }
    }
    if (!rawMembership.table || !rawMembership.foreignKey) {
      throw new Error(`defineService('${id}'): membership needs both 'table' and 'foreignKey'.`);
    }
    if (rawMembership.table === table) {
      throw new Error(
        `defineService('${id}'): membership.table '${table}' is the primary table. MySQL ` +
          'cannot subquery the table it is updating (error 1093), and it would only surface ' +
          'on a member write at runtime.'
      );
    }
    membership = {
      table: rawMembership.table,
      foreignKey: rawMembership.foreignKey,
      localKey: rawMembership.localKey ?? 'id',
      citizenColumn: rawMembership.citizenColumn ?? 'citizenid',
      deviceColumn: rawMembership.deviceColumn ?? null,
      liveWhileNull: rawMembership.liveWhileNull ?? null
    };
  }
  /**
   * `erased` is on every status table (MICA-428): the purges hide a gone owner's rows rather than
   * delete them, and reach every table the owner has rows in. Appended last, after whatever the
   * declaration says, so an existing table's ENUM only ever grows at its end.
   */
  const declaredStatuses = definition.statuses ?? DEFAULT_STATUSES;
  const statuses = declaredStatuses.includes(ERASED)
    ? declaredStatuses
    : [...declaredStatuses, ERASED];

  if (!statuses.includes('active') || !statuses.includes('deleted')) {
    throw new Error(
      `defineService('${id}'): 'statuses' must include both 'active' and 'deleted' — ` +
        'the generic get filters on active and delete is a soft delete.'
    );
  }

  const deviceOwned = definition.deviceOwned === true;
  const devices = resolveDevices(id, definition.devices);

  const fields: { name: string; def: ColumnDef }[] = [];
  /**
   * The device column, first among the declared fields so it sits beside `citizenid` in the
   * DDL. Nullable, because the migration that introduces it to a live table backfills it
   * afterwards and the additive planner compares types, not nullability — a fresh install
   * and an upgraded one have to agree. Never client-writable or filterable: `Repository`'s
   * blanket lists refuse both whatever a declaration says (MICA-281), and it is set by the
   * endpoint from the caller's own inventory.
   */
  if (deviceOwned) {
    if (Object.prototype.hasOwnProperty.call(schema, 'device_id')) {
      throw new Error(
        `defineService('${id}'): 'device_id' is supplied by 'deviceOwned' and must not be ` +
          'declared in the schema as well.'
      );
    }
    fields.push({ name: 'device_id', def: { type: 'string', length: 32, clientWritable: false } });
  }
  /**
   * The row's seal key (MICA-432), for a table bound to its rows: drawn by the write that
   * creates the row (`Repository.create`, or `newSealKey` in a hand-written insert) and never
   * rewritten. Nullable for the reason `device_id` is: the migration that introduces it to a
   * live table fills it afterwards. Never client-writable, never read back.
   */
  if (definition.encryptionBinding !== undefined) {
    if (definition.encryptionBinding !== 'row') {
      throw new Error(
        `defineService('${id}'): encryptionBinding '${String(definition.encryptionBinding)}' ` +
          "is not one. 'row' is the only binding a declaration chooses."
      );
    }
    if (deviceOwned) {
      throw new Error(
        `defineService('${id}'): encryptionBinding 'row' on a 'deviceOwned' table, which is ` +
          'bound to its phone.'
      );
    }
    if (Object.prototype.hasOwnProperty.call(schema, SEAL_KEY_COLUMN)) {
      throw new Error(
        `defineService('${id}'): '${SEAL_KEY_COLUMN}' is supplied by encryptionBinding 'row'.`
      );
    }
    fields.push({
      name: SEAL_KEY_COLUMN,
      def: { type: 'string', length: SEAL_KEY_LENGTH, clientWritable: false, private: true }
    });
  }
  for (const [name, spec] of Object.entries(schema)) {
    if ((IMPLICIT_COLUMNS as readonly string[]).includes(name)) {
      throw new Error(
        `defineService('${id}'): '${name}' is supplied by the framework and must not be ` +
          'declared in the schema.'
      );
    }
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error(
        `defineService('${id}'): field '${name}' must be lower_snake_case — it becomes a ` +
          'SQL identifier.'
      );
    }
    const def = normalizeColumn(spec);
    /**
     * `private` withholds a column from the read projection; `clientFilterable` accepts it
     * as a `WHERE` predicate. Together they describe a column a caller may test for but
     * never see — narrow by a guess, count the rows, and the value is known without it
     * crossing the wire.
     *
     * A throw rather than a silent exclusion, because a silently-ignored flag is the exact
     * failure this ticket exists to undo: `clientFilterable: true` was honoured everywhere
     * except in the one derivation that mattered, and it read as working for months.
     *
     * Reachable only since filtering stopped implying writability. The pairing needed
     * `clientWritable: false` to be interesting, and that used to zero the filter list.
     */
    if (def.private === true && def.clientFilterable === true) {
      throw new Error(
        `defineService('${id}'): '${name}' is both 'private' and 'clientFilterable'. A ` +
          'column withheld from the read projection but accepted as a filter can be ' +
          'tested for without ever being returned.'
      );
    }
    /**
     * A generated column takes its value from `generatedAs` alone. `clientWritable: true`
     * would be a lie `isClientWritable` already ignores — MySQL/MariaDB refuse an explicit
     * value for a virtual generated column outright — so a declaration that says both is
     * corrected here rather than silently doing the safe thing and leaving the
     * contradiction on the page. `default`/`defaultNow` are the same mistake the other way:
     * neither is legal SQL alongside `GENERATED ALWAYS AS (...)`.
     */
    if (def.generatedAs && def.clientWritable === true) {
      throw new Error(
        `defineService('${id}'): '${name}' is 'generatedAs' but also 'clientWritable: true'. ` +
          'A generated column can never accept a client-written value.'
      );
    }
    if (def.generatedAs && (def.default !== undefined || def.defaultNow)) {
      throw new Error(
        `defineService('${id}'): '${name}' is 'generatedAs' but also declares a default. A ` +
          'generated column takes its value from the expression alone.'
      );
    }
    if (def.reviveAs !== undefined && !def.generatedAs) {
      throw new Error(
        `defineService('${id}'): '${name}' declares 'reviveAs' without 'generatedAs'. Only a ` +
          'generated copy of another column is compared as that column.'
      );
    }
    assertCitizenIdColumn(id, `'${name}'`, def);
    assertEncryptedColumn(id, name, def);
    fields.push({ name, def });
  }
  const blindIndexes = addBlindIndexColumns(id, fields, [
    ...IMPLICIT_COLUMNS,
    ...fields.map((f) => f.name)
  ]);

  const columns = [...IMPLICIT_COLUMNS, ...fields.map((f) => f.name)] as string[];
  for (const { name, def } of fields) {
    if (def.reviveAs !== undefined && !columns.includes(def.reviveAs)) {
      throw new Error(
        `defineService('${id}'): '${name}' is 'reviveAs' '${def.reviveAs}', which the table ` +
          'does not have.'
      );
    }
  }

  const indexes = (definition.indexes ?? []).map(normalizeIndex);
  // The handover's own lookup — `UPDATE … WHERE device_id = ?` — and the narrowing half of
  // every scoped read. One plain key, named for the column like `citizenid_status` is.
  if (deviceOwned) indexes.push({ name: 'device_id', columns: ['device_id'], unique: false });
  for (const index of indexes) {
    if (index.columns.length === 0) {
      throw new Error(`defineService('${id}'): an index must name at least one column.`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(index.name)) {
      throw new Error(
        `defineService('${id}'): index name '${index.name}' must be lower_snake_case.`
      );
    }
    for (const column of index.columns) {
      if (!columns.includes(column)) {
        throw new Error(
          `defineService('${id}'): index references '${column}', which is not a column.`
        );
      }
    }
  }

  // Every index name the primary table will emit. A duplicate is MySQL error 1061,
  // and it would only surface when somebody applies the generated file — so catch it
  // at declaration time instead.
  const emittedIndexNames = [
    'status',
    'citizenid_status',
    ...fields.filter((f) => f.def.index).map((f) => `citizenid_${f.name}`),
    ...indexes.map((index) => index.name)
  ];
  const duplicateIndex = emittedIndexNames.find((name, i) => emittedIndexNames.indexOf(name) !== i);
  if (duplicateIndex) {
    throw new Error(
      `defineService('${id}'): index name '${duplicateIndex}' is emitted twice on ` +
        `'${table}'. The primary table always carries \`status\` and \`citizenid_status\`; ` +
        'do not redeclare them.'
    );
  }

  const uniqueAfterDelete = resolveUniqueAfterDelete(id, definition, indexes, fields);

  const childTables = definition.childTables ?? [];
  for (const child of childTables) {
    if (!child.name || !/^[a-z][a-z0-9_]*$/.test(child.name)) {
      throw new Error(
        `defineService('${id}'): child table name '${child.name}' must be lower_snake_case.`
      );
    }
    if (!child.columns || Object.keys(child.columns).length === 0) {
      throw new Error(
        `defineService('${id}'): child table '${child.name}' must declare at least one column.`
      );
    }
    for (const [column, spec] of Object.entries(child.columns)) {
      if (!/^[a-z][a-z0-9_]*$/.test(column)) {
        throw new Error(
          `defineService('${id}'): child table '${child.name}' column '${column}' must be ` +
            'lower_snake_case — it becomes a SQL identifier.'
        );
      }
      assertCitizenIdColumn(
        id,
        `child table '${child.name}' column '${column}'`,
        normalizeColumn(spec)
      );
    }
    const childIndexNames = (child.indexes ?? []).map((i) => normalizeIndex(i).name);
    const duplicateChildIndex = childIndexNames.find(
      (name, i) => childIndexNames.indexOf(name) !== i
    );
    if (duplicateChildIndex) {
      throw new Error(
        `defineService('${id}'): child table '${child.name}' emits index name ` +
          `'${duplicateChildIndex}' twice.`
      );
    }
    assertChildUniqueAfterDelete(id, child);
    if (child.name === table) {
      throw new Error(
        `defineService('${id}'): child table '${child.name}' collides with the primary table.`
      );
    }
  }

  const resolvedChildren = childTables.map((child) => resolveChildEncryption(id, child));
  // A child table's versioned columns are written by named SQL (MICA-430); checked the same.
  for (const child of childTables) {
    versionedColumnsOf(
      id,
      child.name,
      Object.entries(child.columns).map(([name, spec]) => ({ name, def: normalizeColumn(spec) }))
    );
  }

  const isPrivate = (column: string): boolean =>
    fields.some((f) => f.name === column && f.def.private === true);

  const publicColumns = columns.filter((column) => column !== 'citizenid' && !isPrivate(column));
  const listColumns = columns.filter((column) => !isPrivate(column));

  const columnRules: Record<string, ColumnRule> = {};
  for (const { name, def } of fields) {
    columnRules[name] = {
      type: def.type,
      maxLength: def.citizenId
        ? CITIZENID_MAX_LENGTH
        : def.type === 'string'
          ? (def.length ?? 255)
          : def.encrypted
            ? maxPlaintextChars(MAX_LENGTH_BY_TYPE[def.type] ?? 0, def.ascii === true ? 1 : 4)
            : MAX_LENGTH_BY_TYPE[def.type],
      citizenId: def.citizenId === true,
      values: def.type === 'enum' ? (def.values ?? null) : null,
      min: def.type === 'int' ? INT_MIN : null,
      max: def.type === 'int' ? INT_MAX : null,
      accepts: def.accepts ?? null,
      ascii: def.ascii === true
    };
  }

  const encryptedColumns = fields.filter((f) => f.def.encrypted === true).map((f) => f.name);
  const encryptionScope = resolveEncryptionScope(definition, columns, fields, encryptedColumns);

  /**
   * An encrypted `string` is stored in its sealed form, so the table is emitted as wide as that
   * form needs: the DDL, the planner and `mica.sql` read these widened fields. The rule above
   * has already taken `length` as the plaintext bound, which is what a write is held to.
   */
  const storedFields = fields.map((field) =>
    field.def.encrypted && field.def.type === 'string'
      ? {
          name: field.name,
          def: { ...field.def, length: storedWidth(field.def) }
        }
      : field
  );

  return {
    id,
    table,
    deviceOwned,
    devices,
    access,
    membership,
    editWindow,
    paging,
    columnRules,
    publicColumns,
    listColumns,
    statuses,
    fields: storedFields,
    indexes,
    uniqueAfterDelete,
    childTables: resolvedChildren.map((r) => r.child),
    childEncryption: resolvedChildren.flatMap((r) => (r.encryption ? [r.encryption] : [])),
    encryptedColumns,
    versioned: versionedColumnsOf(id, table, fields),
    encryptionScope,
    encryptionBinding: deviceOwned
      ? 'device'
      : definition.encryptionBinding === 'row'
        ? 'row'
        : 'citizen',
    blindIndexes,
    reactable: resolveReactable(id, definition.reactable),
    columns,
    clientWritable: fields.filter((f) => isClientWritable(f.def, access.write)).map((f) => f.name),
    clientFilterable: fields.filter((f) => isClientFilterable(f.def)).map((f) => f.name)
  };
}

/**
 * A Repository whose allowlists come from a resolved schema.
 *
 * A concrete, exported class rather than a generated one, so an app that needs
 * custom read shaping can `extends SchemaRepository<T>` and still inherit every
 * Phase 1 guarantee — the identifier allowlist and the ownership scoping.
 */
export class SchemaRepository<T> extends Repository<T> {
  protected tableName: string;
  protected columns: readonly string[];
  protected clientWritable: readonly string[];
  protected clientFilterable: readonly string[];
  protected membership: ResolvedMembership | null;

  constructor(resolved: ResolvedService) {
    super();
    this.tableName = resolved.table;
    this.columns = resolved.columns;
    this.clientWritable = resolved.clientWritable;
    this.clientFilterable = resolved.clientFilterable;
    this.membership = resolved.membership;
    this.columnRules = resolved.columnRules;
    this.editWindow = resolved.editWindow;
    this.versionedColumns = resolved.versioned;
    if (resolved.uniqueAfterDelete === 'revive') {
      // A generated copy is compared as the column it copies (`reviveAs`, MICA-428).
      const reviveAs = new Map(
        resolved.fields
          .filter((field) => field.def.reviveAs !== undefined)
          .map((field) => [field.name, field.def.reviveAs!])
      );
      this.reviveKeys = resolved.indexes
        .filter((index) => index.unique)
        .map((index) => index.columns.map((column) => reviveAs.get(column) ?? column));
      this.reviveResets = resolved.fields
        .filter((field) => !field.def.generatedAs && field.name !== 'device_id')
        .map((field) => field.name);
    }
  }
}

/** Build a Repository bound to a resolved schema. */
export function buildRepository<T>(resolved: ResolvedService): Repository<T> {
  return new SchemaRepository<T>(resolved);
}

export interface ServerAppHandle<T, C extends ServiceContract = ServiceContract> {
  resolved: ResolvedService;
  repo: Repository<T>;
  app: ServiceEndpoint<T, C>;
}

/**
 * Every schema declared this process. `scripts/generate-sql.js` imports the
 * services and reads this to emit DDL, which is why declaring a service is enough
 * to get its table file — no separate registration step to forget.
 */
export const declaredServices: ResolvedService[] = [];

/**
 * Every repository whose table carries a `device_id`, declared this process (MICA-282).
 *
 * The handover in `services/Devices.ts` walks this list and calls `transferDeviceRows` on each,
 * so a table that follows the phone follows it without being named anywhere but its own
 * declaration — the same reason `declaredServices` exists for the DDL. `mica_devices` and
 * `mica_phone_numbers` are in it too, by the same rule: they carry the column.
 */
export const deviceKeyedRepositories: Repository<any>[] = [];

/**
 * Declare an app's server half: derives the repository, registers the generic CRUD
 * events, and hands back the pieces so custom actions can be added on top.
 *
 * What the access axes turn off, and why each one has to:
 *
 * - `write: 'server'` — create and update. The client has no business authoring the row.
 *   Delete stays, because a server-authored row still belongs to exactly one citizenid.
 * - `write: 'members'` — create, update and delete. Ownership is the wrong question, and
 *   the parent id a membership check needs is not part of the generic payload contract.
 * - `read: 'members'` — get, for the same reason: the generic filter path cannot require
 *   a parent id, so it would have nothing to check membership against.
 *
 * A `members` app therefore supplies its own actions and calls `repo.isMember(...)` — one
 * derived query rather than the two hand-written copies Conversations and Messages had.
 */
export function defineService<T, C extends ServiceContract = ServiceContract>(
  definition: ServiceDefinition<C>
): ServerAppHandle<T, C> {
  const resolved = resolveAppSchema(definition);

  if (definition.contract && definition.contract.id !== resolved.id) {
    throw new Error(
      `defineService('${resolved.id}'): its contract declares id '${definition.contract.id}'. ` +
        'The contract id is the `<service>` segment of every event this endpoint registers, ' +
        'so two names for one service would be a contract nothing on the wire matches.'
    );
  }
  const repo = definition.repositoryFactory
    ? (definition.repositoryFactory(resolved) as Repository<T>)
    : buildRepository<T>(resolved);
  /**
   * A factory that builds something other than a `SchemaRepository` would drop `'revive'`
   * without a word, and a decision that silently does not happen reads as one that does.
   */
  if (resolved.uniqueAfterDelete === 'revive' && repo.revivesUnder.length === 0) {
    throw new Error(
      `defineService('${resolved.id}'): 'uniqueAfterDelete' is 'revive', but the repository ` +
        "its 'repositoryFactory' built revives under no key. Extend SchemaRepository."
    );
  }

  if (declaredServices.some((existing) => existing.table === resolved.table)) {
    throw new Error(
      `defineService('${resolved.id}'): table '${resolved.table}' is already declared by ` +
        'another app. Two apps sharing a table would each believe they own its schema.'
    );
  }
  declaredServices.push(resolved);
  if (resolved.columns.includes('device_id')) deviceKeyedRepositories.push(repo);

  /**
   * Every encrypted column joins the registry `lib/contentCipher.ts` keeps, which the generic
   * repository path, the hand-written readers and the backfill all walk (MICA-165).
   */
  for (const column of resolved.encryptedColumns) {
    registerEncryptedColumn({
      table: resolved.table,
      column,
      scope: resolved.encryptionScope,
      // A phone's rows change hands by `citizenid` (MICA-431): bound to the phone instead. A
      // row whose `citizenid` passes on is bound to the row (MICA-432).
      binding: resolved.encryptionBinding,
      hasUpdatedAt: resolved.columns.includes('updated_at')
    });
  }
  for (const entry of resolved.blindIndexes) {
    registerBlindIndex({ table: resolved.table, ...entry });
  }
  /**
   * What only the server reads leaves no reply (MICA-432): each index, each generated key built
   * on one, and the seal key — on the primary table and on its sealed children alike.
   */
  const indexColumns = [
    ...resolved.blindIndexes.map((entry) => entry.index),
    ...resolved.childEncryption.flatMap((child) => child.blindIndexes.map((entry) => entry.index))
  ];
  const generatedOver = [
    ...resolved.fields,
    ...resolved.childTables.flatMap((child) =>
      Object.entries(child.columns).map(([name, spec]) => ({ name, def: normalizeColumn(spec) }))
    )
  ]
    .filter(({ def }) => indexColumns.some((index) => def.generatedAs?.includes(`\`${index}\``)))
    .map(({ name }) => name);
  registerServerOnlyColumns([
    ...indexColumns,
    ...generatedOver,
    ...(resolved.encryptionBinding === 'row' ? [SEAL_KEY_COLUMN] : [])
  ]);
  for (const child of resolved.childEncryption) {
    for (const column of child.columns) {
      registerEncryptedColumn({
        table: child.table,
        column,
        scope: child.scope,
        binding: 'citizen',
        hasUpdatedAt: child.hasUpdatedAt
      });
    }
    for (const entry of child.blindIndexes) registerBlindIndex({ table: child.table, ...entry });
  }

  /**
   * Opt in to moderation, if the declaration asked for it.
   *
   * Here rather than in `lib/moderation.ts`'s own list, so that core never names an app's
   * table. Validated at declaration time because the alternative is a SQL error at review
   * time — the one moment a moderator cannot afford one — and `summariseTarget` selects
   * `citizenid` and `status` alongside the preview column.
   */
  if (definition.reportable) {
    const { previewColumn } = definition.reportable;
    if (!resolved.columns.includes(previewColumn)) {
      throw new Error(
        `defineService('${resolved.id}'): reportable previewColumn '${previewColumn}' is not ` +
          `a column on '${resolved.table}'. The review queue reads it directly.`
      );
    }
    registerReportable(resolved.table, definition.reportable);
  }

  const accessLockdown: ServiceOptions<C> = {
    ...(resolved.access.read === 'members' ? { disableGet: true } : {}),
    ...(resolved.access.write === 'server' ? { disableCreate: true, disableUpdate: true } : {}),
    ...(resolved.access.write === 'members'
      ? { disableCreate: true, disableUpdate: true, disableDelete: true }
      : {})
  };

  const app = new ServiceEndpoint<T, C>(resolved.id, repo, {
    tableName: resolved.table,
    ...(definition.app ? { app: definition.app } : {}),
    ...(resolved.deviceOwned ? { deviceOwned: true } : {}),
    devices: resolved.devices,
    ...(definition.contract ? { contract: definition.contract } : {}),
    ...(resolved.access.read === 'public'
      ? { publicRead: true, publicColumns: resolved.publicColumns }
      : {}),
    /**
     * Only when something is actually withheld.
     *
     * A service with no `private` column passes no projection at all, so `findAll` emits the
     * byte-identical `SELECT *` it always did — which several `repositoryFactory` subclasses
     * and `Repository.test.ts`'s exact query strings depend on. Narrowing is opt-in per
     * column, and a table that opted into nothing pays nothing.
     */
    ...(resolved.listColumns.length !== resolved.columns.length
      ? { listColumns: resolved.listColumns }
      : {}),
    ...(resolved.paging ? { paging: resolved.paging } : {}),
    ...accessLockdown,
    ...definition.options
  });

  return { resolved, repo, app };
}
