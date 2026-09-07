// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Repository } from './Repository';
import { registerReportable, type ReportableDefinition } from './moderation';
import { registerReactable, type ReactableDefinition } from './reactions';
import { ServiceEndpoint, ServiceOptions } from './ServiceEndpoint';
import type { ServiceContract } from '@mica/shared/contract';

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
  /** Characters, for the text-ish types. Null when length is not the constraint. */
  maxLength: number | null;
  /** Permitted values, for `enum`. Null otherwise. */
  values: readonly string[] | null;
  /** Inclusive bounds for `int`. Null otherwise. */
  min: number | null;
  max: number | null;
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
}

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
  phoneColumn?: string;
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
  /** The membership table's phone column, or null when membership belongs to the citizen alone. */
  phoneColumn: string | null;
  liveWhileNull: string | null;
}

export interface ServiceDefinition<C extends ServiceContract = ServiceContract> {
  /** Matches the web module's manifest id. */
  id: string;
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
   * Make this service's rows reactable — `mica_account_reactions` may target them.
   *
   * Same shape as `reportable` and for the same reason: declared here so core never has to
   * name an add-on's table, and validated at declaration time rather than failing the first
   * time a reaction targets it.
   */
  reactable?: ReactableDefinition;
  /**
   * The rows follow the phone, not the character (MICA-282).
   *
   * Injects a nullable `phone_id` column and a `phone_id` index, and makes every generic
   * action scope by the caller's active phone as well as their citizenid — the phone id is
   * resolved by `ServiceEndpoint` from the item in the caller's own inventory and handed to
   * custom handlers as their sixth argument. A row's `citizenid` names whoever holds the phone
   * now, and moves with it: `services/Phones.ts` calls `transferPhoneRows` on every table
   * with a `phone_id` column when a phone changes hands. Declare it for what belongs to the
   * *device* — contacts, notes, media, the lock screen — and never for what belongs to the
   * *person*, or a stolen phone hands over somebody's money. `docs/schema-and-services.md`
   * has the split, table by table.
   */
  deviceOwned?: boolean;
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
  childTables: readonly ChildTableDefinition[];
}

/**
 * Expand a declaration into the concrete lists the runtime needs. Pure — no
 * database, no event registration — so it is cheap to test and to feed to codegen.
 */
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
      ['phoneColumn', rawMembership.phoneColumn],
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
      phoneColumn: rawMembership.phoneColumn ?? null,
      liveWhileNull: rawMembership.liveWhileNull ?? null
    };
  }
  const statuses = definition.statuses ?? DEFAULT_STATUSES;

  if (!statuses.includes('active') || !statuses.includes('deleted')) {
    throw new Error(
      `defineService('${id}'): 'statuses' must include both 'active' and 'deleted' — ` +
        'the generic get filters on active and delete is a soft delete.'
    );
  }

  const deviceOwned = definition.deviceOwned === true;

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
    if (Object.prototype.hasOwnProperty.call(schema, 'phone_id')) {
      throw new Error(
        `defineService('${id}'): 'phone_id' is supplied by 'deviceOwned' and must not be ` +
          'declared in the schema as well.'
      );
    }
    fields.push({ name: 'phone_id', def: { type: 'string', length: 32, clientWritable: false } });
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
    fields.push({ name, def });
  }

  const columns = [...IMPLICIT_COLUMNS, ...fields.map((f) => f.name)] as string[];

  const indexes = (definition.indexes ?? []).map(normalizeIndex);
  // The handover's own lookup — `UPDATE … WHERE phone_id = ?` — and the narrowing half of
  // every scoped read. One plain key, named for the column like `citizenid_status` is.
  if (deviceOwned) indexes.push({ name: 'phone_id', columns: ['phone_id'], unique: false });
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
    for (const column of Object.keys(child.columns)) {
      if (!/^[a-z][a-z0-9_]*$/.test(column)) {
        throw new Error(
          `defineService('${id}'): child table '${child.name}' column '${column}' must be ` +
            'lower_snake_case — it becomes a SQL identifier.'
        );
      }
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
    if (child.name === table) {
      throw new Error(
        `defineService('${id}'): child table '${child.name}' collides with the primary table.`
      );
    }
  }

  const isPrivate = (column: string): boolean =>
    fields.some((f) => f.name === column && f.def.private === true);

  const publicColumns = columns.filter((column) => column !== 'citizenid' && !isPrivate(column));
  const listColumns = columns.filter((column) => !isPrivate(column));

  const columnRules: Record<string, ColumnRule> = {};
  for (const { name, def } of fields) {
    columnRules[name] = {
      type: def.type,
      maxLength: def.type === 'string' ? (def.length ?? 255) : MAX_LENGTH_BY_TYPE[def.type],
      values: def.type === 'enum' ? (def.values ?? null) : null,
      min: def.type === 'int' ? INT_MIN : null,
      max: def.type === 'int' ? INT_MAX : null
    };
  }

  return {
    id,
    table,
    deviceOwned,
    access,
    membership,
    editWindow,
    paging,
    columnRules,
    publicColumns,
    listColumns,
    statuses,
    fields,
    indexes,
    childTables,
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
 * Every repository whose table carries a `phone_id`, declared this process (MICA-282).
 *
 * The handover in `services/Phones.ts` walks this list and calls `transferPhoneRows` on each,
 * so a table that follows the phone follows it without being named anywhere but its own
 * declaration — the same reason `declaredServices` exists for the DDL. `mica_phones` and
 * `mica_phone_numbers` are in it too, by the same rule: they carry the column.
 */
export const phoneKeyedRepositories: Repository<any>[] = [];

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

  if (declaredServices.some((existing) => existing.table === resolved.table)) {
    throw new Error(
      `defineService('${resolved.id}'): table '${resolved.table}' is already declared by ` +
        'another app. Two apps sharing a table would each believe they own its schema.'
    );
  }
  declaredServices.push(resolved);
  if (resolved.columns.includes('phone_id')) phoneKeyedRepositories.push(repo);

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

  /** Opt in to reactions, if the declaration asked for it. Same reasoning as `reportable`. */
  if (definition.reactable) {
    registerReactable(resolved.table, definition.reactable);
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
    ...(resolved.deviceOwned ? { deviceOwned: true } : {}),
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
