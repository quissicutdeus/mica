import { Repository } from './Repository';
import { ServerApp, ServerAppOptions } from './ServerApp';

/**
 * One declaration per app, replacing the hand-written repository + controller pair.
 *
 * The declaration is the single source of truth for three things that were
 * previously maintained by hand and could silently diverge:
 *
 *   1. the table's DDL (see `toCreateTableSql`)
 *   2. the `columns` allowlist that guards SQL identifier interpolation (§2.9)
 *   3. the `clientWritable` set that `ServerApp` reduces payloads to
 *
 * (2) is only *safe* if it matches the real table, so deriving both from one
 * schema removes a class of bug rather than just saving keystrokes.
 *
 * Kept free of any import from `web/`, so a later move to a shared single-root
 * layout is a file move rather than a rewrite.
 */

export type ColumnType = 'string' | 'text' | 'mediumtext' | 'int' | 'bool' | 'json' | 'blob';

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
}

/** `{ title: 'string' }` is shorthand for `{ title: { type: 'string' } }`. */
export type AppSchema = Record<string, ColumnType | ColumnDef>;

/**
 * `owner` — rows belong to one citizenid; the generic CRUD path is safe as-is.
 * `shared` — rows are visible to several players (conversations, messages), so
 *   ownership is the wrong authorization question and the generic mutation path
 *   is disabled. A shared app must supply custom actions that check membership.
 */
export type AppScope = 'owner' | 'shared';

export interface ServerAppDefinition {
  /** Matches the web module's manifest id. */
  id: string;
  /** Defaults to `gphone_<id>`. */
  table?: string;
  /** Defaults to 'owner'. */
  scope?: AppScope;
  /**
   * Rows are written by the server, never by the phone's owner — mail arriving from
   * a job, a bank alert, a dispatch. Nothing becomes client-writable and the generic
   * create/update events are not registered, so an app cannot accidentally expose a
   * write path for data the client has no business authoring.
   *
   * Distinct from `scope: 'shared'`: a server-authored row still belongs to exactly
   * one citizenid, so ownership scoping on reads and deletes is still correct.
   */
  serverAuthored?: boolean;
  schema: AppSchema;
  /** Values the `status` column accepts. Defaults to active/deleted. */
  statuses?: readonly string[];
  /**
   * Composite indexes, each a full ordered column list — e.g.
   * `[['citizenid', 'status', 'updated_at']]`. Needed because a per-column `index`
   * flag cannot express the multi-column indexes the existing tables rely on, and a
   * declaration that cannot express them would silently drop them on migration.
   */
  indexes?: readonly (readonly string[])[];
  /** Passed through to ServerApp — e.g. `{ disableUpdate: true }`. */
  options?: ServerAppOptions;
  /**
   * Escape hatch for apps that need custom read shaping — e.g. coercing a blob
   * column to a string before it crosses NUI. Subclass `SchemaRepository` so the
   * result still inherits the `columns` allowlist and the ownership scoping;
   * overriding a method is additive, not a way around §2.9.
   */
  repositoryFactory?: (resolved: ResolvedAppSchema) => Repository<any>;
}

/** Columns every gPhone table carries. Declared by the framework, not by an app. */
const IMPLICIT_COLUMNS = ['id', 'citizenid', 'status', 'created_at', 'updated_at'] as const;

const DEFAULT_STATUSES = ['active', 'deleted'] as const;

const normalizeColumn = (spec: ColumnType | ColumnDef): ColumnDef =>
  typeof spec === 'string' ? { type: spec } : spec;

/**
 * A field is client-writable unless it opts out. Shared-scope and server-authored
 * apps opt every field out wholesale.
 */
const isClientWritable = (def: ColumnDef, scope: AppScope, serverAuthored: boolean): boolean =>
  scope === 'owner' && !serverAuthored && def.clientWritable !== false;

export interface ResolvedAppSchema {
  id: string;
  table: string;
  scope: AppScope;
  serverAuthored: boolean;
  statuses: readonly string[];
  /** Declared fields only, in declaration order — implicit columns excluded. */
  fields: { name: string; def: ColumnDef }[];
  columns: string[];
  clientWritable: string[];
  clientFilterable: string[];
  indexes: readonly (readonly string[])[];
}

/**
 * Expand a declaration into the concrete lists the runtime needs. Pure — no
 * database, no event registration — so it is cheap to test and to feed to codegen.
 */
export function resolveAppSchema(definition: ServerAppDefinition): ResolvedAppSchema {
  const { id, schema } = definition;

  if (!id || typeof id !== 'string') {
    throw new Error("defineServerApp: 'id' is required and must be a string.");
  }
  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) {
    throw new Error(`defineServerApp('${id}'): 'schema' must declare at least one field.`);
  }

  const scope = definition.scope ?? 'owner';
  const serverAuthored = definition.serverAuthored === true;
  const table = definition.table ?? `gphone_${id}`;
  const statuses = definition.statuses ?? DEFAULT_STATUSES;

  if (!statuses.includes('active') || !statuses.includes('deleted')) {
    throw new Error(
      `defineServerApp('${id}'): 'statuses' must include both 'active' and 'deleted' — ` +
        'the generic get filters on active and delete is a soft delete.'
    );
  }

  const fields: { name: string; def: ColumnDef }[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    if ((IMPLICIT_COLUMNS as readonly string[]).includes(name)) {
      throw new Error(
        `defineServerApp('${id}'): '${name}' is supplied by the framework and must not be ` +
          'declared in the schema.'
      );
    }
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error(
        `defineServerApp('${id}'): field '${name}' must be lower_snake_case — it becomes a ` +
          'SQL identifier.'
      );
    }
    fields.push({ name, def: normalizeColumn(spec) });
  }

  const columns = [...IMPLICIT_COLUMNS, ...fields.map((f) => f.name)] as string[];

  const indexes = definition.indexes ?? [];
  for (const index of indexes) {
    if (index.length === 0) {
      throw new Error(`defineServerApp('${id}'): an index must name at least one column.`);
    }
    for (const column of index) {
      if (!columns.includes(column)) {
        throw new Error(
          `defineServerApp('${id}'): index references '${column}', which is not a column.`
        );
      }
    }
  }

  return {
    id,
    table,
    scope,
    serverAuthored,
    statuses,
    fields,
    indexes,
    columns,
    clientWritable: fields
      .filter((f) => isClientWritable(f.def, scope, serverAuthored))
      .map((f) => f.name),
    clientFilterable: fields
      .filter(
        (f) => f.def.clientFilterable === true && isClientWritable(f.def, scope, serverAuthored)
      )
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

  constructor(resolved: ResolvedAppSchema) {
    super();
    this.tableName = resolved.table;
    this.columns = resolved.columns;
    this.clientWritable = resolved.clientWritable;
    this.clientFilterable = resolved.clientFilterable;
  }
}

/** Build a Repository bound to a resolved schema. */
export function buildRepository<T>(resolved: ResolvedAppSchema): Repository<T> {
  return new SchemaRepository<T>(resolved);
}

export interface ServerAppHandle<T> {
  resolved: ResolvedAppSchema;
  repo: Repository<T>;
  app: ServerApp<T>;
}

/**
 * Every schema declared this process. `scripts/generate-sql.js` imports the
 * controllers and reads this to emit DDL, which is why declaring an app is enough
 * to get its table file — no separate registration step to forget.
 */
export const declaredApps: ResolvedAppSchema[] = [];

/**
 * Declare an app's server half: derives the repository, registers the generic CRUD
 * events, and hands back the pieces so custom actions can be added on top.
 *
 * A `shared`-scope app gets no generic mutation events — ownership by citizenid is
 * not a valid authorization check for rows several players can see.
 */
export function defineServerApp<T>(definition: ServerAppDefinition): ServerAppHandle<T> {
  const resolved = resolveAppSchema(definition);
  const repo = definition.repositoryFactory
    ? (definition.repositoryFactory(resolved) as Repository<T>)
    : buildRepository<T>(resolved);

  if (declaredApps.some((existing) => existing.table === resolved.table)) {
    throw new Error(
      `defineServerApp('${resolved.id}'): table '${resolved.table}' is already declared by ` +
        'another app. Two apps sharing a table would each believe they own its schema.'
    );
  }
  declaredApps.push(resolved);

  // Shared scope cannot authorize any mutation by ownership. Server-authored tables
  // still own their rows, so delete stays available — only authoring is closed.
  const scopeLockdown: ServerAppOptions =
    resolved.scope === 'shared'
      ? { disableCreate: true, disableUpdate: true, disableDelete: true }
      : resolved.serverAuthored
        ? { disableCreate: true, disableUpdate: true }
        : {};

  const app = new ServerApp<T>(resolved.id, repo, {
    tableName: resolved.table,
    ...scopeLockdown,
    ...definition.options
  });

  return { resolved, repo, app };
}
