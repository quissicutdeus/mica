import { Repository } from './Repository';
import { ServiceEndpoint, ServiceOptions } from './ServiceEndpoint';

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
  'string' | 'text' | 'mediumtext' | 'int' | 'bool' | 'json' | 'blob' | 'timestamp' | 'enum';

/** A foreign key onto another table. `players` is implied for `citizenid`. */
interface ColumnReference {
  table: string;
  column: string;
  /** Defaults to CASCADE, matching every existing gphone FK. */
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
  /** May a client filter on this column through the generic `get`? Default false. */
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
  /** Foreign key onto another table. */
  references?: ColumnReference;
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
  /** Full table name; no `gphone_` prefix is added. */
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
   * `members` — decided by `membership`, and the generic `get` is **not** registered:
   *             a membership read needs the parent id from the payload, which the
   *             generic filter path has no way to require. Supply a custom action and
   *             call `repo.isMember(...)`.
   */
  read: 'owner' | 'members';
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
  /** Membership is live only while this column IS NULL — `left_at`. */
  liveWhileNull?: string;
}

export interface ResolvedMembership {
  table: string;
  foreignKey: string;
  localKey: string;
  citizenColumn: string;
  liveWhileNull: string | null;
}

export interface ServiceDefinition {
  /** Matches the web module's manifest id. */
  id: string;
  /** Defaults to `gphone_<id>`. */
  table?: string;
  /** Defaults to `{ read: 'owner', write: 'owner' }`. */
  access?: AccessDefinition;
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
  options?: ServiceOptions;
  /**
   * Escape hatch for apps that need custom read shaping — e.g. coercing a blob
   * column to a string before it crosses NUI. Subclass `SchemaRepository` so the
   * result still inherits the `columns` allowlist and the ownership scoping;
   * overriding a method is additive, not a way around §2.9.
   */
  repositoryFactory?: (resolved: ResolvedService) => Repository<any>;
}

/** Columns every gPhone table carries. Declared by the framework, not by an app. */
const IMPLICIT_COLUMNS = ['id', 'citizenid', 'status', 'created_at', 'updated_at'] as const;

const DEFAULT_STATUSES = ['active', 'deleted'] as const;

const normalizeColumn = (spec: ColumnType | ColumnDef): ColumnDef =>
  typeof spec === 'string' ? { type: spec } : spec;

/**
 * A field is client-writable unless it opts out. Only an owner-write table has a generic
 * client write path at all, so `server` and `members` opt every field out wholesale.
 */
const isClientWritable = (def: ColumnDef, write: AccessDefinition['write']): boolean =>
  write === 'owner' && def.clientWritable !== false;

export interface ResolvedService {
  id: string;
  table: string;
  access: Required<Pick<AccessDefinition, 'read' | 'write'>>;
  /** Resolved defaults filled in; null unless an axis is `members`. */
  membership: ResolvedMembership | null;
  statuses: readonly string[];
  /** Declared fields only, in declaration order — implicit columns excluded. */
  fields: { name: string; def: ColumnDef }[];
  columns: string[];
  clientWritable: string[];
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

  const table = definition.table ?? `gphone_${id}`;

  let membership: ResolvedMembership | null = null;
  if (rawMembership) {
    const identifiers: [string, string | undefined][] = [
      ['table', rawMembership.table],
      ['foreignKey', rawMembership.foreignKey],
      ['localKey', rawMembership.localKey],
      ['citizenColumn', rawMembership.citizenColumn],
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

  const fields: { name: string; def: ColumnDef }[] = [];
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
    fields.push({ name, def: normalizeColumn(spec) });
  }

  const columns = [...IMPLICIT_COLUMNS, ...fields.map((f) => f.name)] as string[];

  const indexes = (definition.indexes ?? []).map(normalizeIndex);
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

  return {
    id,
    table,
    access,
    membership,
    statuses,
    fields,
    indexes,
    childTables,
    columns,
    clientWritable: fields.filter((f) => isClientWritable(f.def, access.write)).map((f) => f.name),
    clientFilterable: fields
      .filter((f) => f.def.clientFilterable === true && isClientWritable(f.def, access.write))
      .map((f) => f.name)
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
  }
}

/** Build a Repository bound to a resolved schema. */
export function buildRepository<T>(resolved: ResolvedService): Repository<T> {
  return new SchemaRepository<T>(resolved);
}

export interface ServerAppHandle<T> {
  resolved: ResolvedService;
  repo: Repository<T>;
  app: ServiceEndpoint<T>;
}

/**
 * Every schema declared this process. `scripts/generate-sql.js` imports the
 * services and reads this to emit DDL, which is why declaring a service is enough
 * to get its table file — no separate registration step to forget.
 */
export const declaredServices: ResolvedService[] = [];

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
export function defineService<T>(definition: ServiceDefinition): ServerAppHandle<T> {
  const resolved = resolveAppSchema(definition);
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

  const accessLockdown: ServiceOptions = {
    ...(resolved.access.read === 'members' ? { disableGet: true } : {}),
    ...(resolved.access.write === 'server' ? { disableCreate: true, disableUpdate: true } : {}),
    ...(resolved.access.write === 'members'
      ? { disableCreate: true, disableUpdate: true, disableDelete: true }
      : {})
  };

  const app = new ServiceEndpoint<T>(resolved.id, repo, {
    tableName: resolved.table,
    ...accessLockdown,
    ...definition.options
  });

  return { resolved, repo, app };
}
