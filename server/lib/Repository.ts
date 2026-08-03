import { Database } from './Database';
import type { ResolvedMembership } from './defineService';

/**
 * Columns no client payload may ever write, on any table.
 *
 * `id` is the primary key, `citizenid` is the ownership anchor and is always
 * supplied by the server from the framework, and the timestamps are managed by
 * MySQL. A repository that lists any of these in `clientWritable` still will not
 * get them — this set is subtracted last.
 */
const NEVER_CLIENT_WRITABLE = new Set(['id', 'citizenid', 'created_at', 'updated_at']);

export abstract class Repository<T> {
  protected abstract tableName: string;

  /**
   * Every column that physically exists on `tableName`.
   *
   * This is the SQL identifier allowlist, and here is why it exists: `create`,
   * `update` and `findAll` build column lists from caller-supplied object keys,
   * and MySQL cannot parameterize an identifier — only a value. Any key outside
   * this list is rejected before it can be spliced into a statement.
   */
  protected abstract columns: readonly string[];

  /**
   * Columns a client payload may write through the generic CRUD path.
   * Empty by default: a table opts in to client writes explicitly.
   */
  protected clientWritable: readonly string[] = [];

  /** Columns a client payload may filter on through the generic `get` path. */
  protected clientFilterable: readonly string[] = [];

  /**
   * How membership is decided for this table, when ownership is the wrong question.
   * Null unless the service declared it. See `isMember`.
   */
  protected membership: ResolvedMembership | null = null;

  public get tableColumns(): readonly string[] {
    return this.columns;
  }

  public get writableColumns(): readonly string[] {
    return this.clientWritable.filter(
      (column) => !NEVER_CLIENT_WRITABLE.has(column) && this.columns.includes(column)
    );
  }

  public get filterableColumns(): readonly string[] {
    return this.clientFilterable.filter((column) => this.columns.includes(column));
  }

  protected get hasStatusColumn(): boolean {
    return this.columns.includes('status');
  }

  protected get hasOwnerColumn(): boolean {
    return this.columns.includes('citizenid');
  }

  /**
   * Is this player a live member of the given parent row?
   *
   * The authorization question for rows several players can see, and §2.9's answer to it:
   * *"For rows shared between players ownership is the wrong question — check membership."*
   *
   * Derived from the service's `membership` declaration rather than hand-written. Two things
   * that buys:
   *
   * Messages used to authorize itself through `ConversationRepository.isParticipant` — one
   * service reaching into another service's repository for its own access control, so a
   * change to how Conversations stores membership silently changed who could read a message.
   * It now asks its own declaration.
   *
   * And the liveness rule stops being a string. `left_at IS NULL` is repeated across five
   * hand-written queries in `ConversationRepository`; each new one is another chance to omit
   * it, and omitting it means a player who left a thread can still act on it.
   *
   * `parentId` is what `membership.localKey` holds — a conversation's own `id`, or a
   * message's `conversation_id`. Every identifier here is validated at declaration time
   * (§2.9: MySQL cannot parameterize an identifier), and both values stay bound.
   */
  async isMember(parentId: number | string, citizenid: string): Promise<boolean> {
    if (!this.membership) {
      throw new Error(
        `[Repository] isMember on '${this.tableName}' requires a 'membership' declaration. ` +
          "Add one to the service's `access`, or authorize by ownership instead."
      );
    }
    if (!citizenid) return false;

    const { table, foreignKey, citizenColumn, liveWhileNull } = this.membership;
    const live = liveWhileNull ? ` AND \`${liveWhileNull}\` IS NULL` : '';
    const query =
      `SELECT 1 FROM \`${table}\` ` +
      `WHERE \`${foreignKey}\` = ? AND \`${citizenColumn}\` = ?${live} LIMIT 1`;

    return Boolean(await Database.single<unknown>(query, [parentId, citizenid]));
  }

  /** Reject any key that is not a real column on this table. */
  private assertColumns(keys: string[], operation: string): void {
    for (const key of keys) {
      if (!this.columns.includes(key)) {
        throw new Error(
          `[Repository] ${operation} on '${this.tableName}' rejected unknown column '${key}'.`
        );
      }
    }
  }

  /**
   * Validate the keys of a caller-supplied object and return them alongside
   * their values in matching order. Values stay parameterized; only validated
   * identifiers are interpolated.
   */
  private prepareColumns(
    data: Record<string, unknown>,
    operation: string
  ): { keys: string[]; values: unknown[] } {
    const keys = Object.keys(data);
    this.assertColumns(keys, operation);
    if (keys.length === 0) {
      throw new Error(
        `[Repository] ${operation} on '${this.tableName}' requires at least one column.`
      );
    }
    return { keys, values: keys.map((key) => data[key]) };
  }

  async create(data: Partial<T>): Promise<number> {
    const { keys, values } = this.prepareColumns(data as Record<string, unknown>, 'create');
    const columnList = keys.map((key) => `\`${key}\``).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const query = `INSERT INTO \`${this.tableName}\` (${columnList}) VALUES (${placeholders})`;
    return await Database.insert(query, values);
  }

  /**
   * Fetch a single row. Pass `citizenid` whenever the caller is acting on behalf
   * of a player so the ownership predicate applies; omit it only for
   * server-internal reads that are already authorized.
   */
  async findById(id: number | string, citizenid?: string): Promise<T | null> {
    let query = `SELECT * FROM \`${this.tableName}\` WHERE \`id\` = ?`;
    const params: unknown[] = [id];

    if (citizenid) {
      if (!this.hasOwnerColumn) {
        throw new Error(
          `[Repository] findById on '${this.tableName}' cannot scope by owner: no 'citizenid' column.`
        );
      }
      query += ' AND `citizenid` = ?';
      params.push(citizenid);
    }

    return await Database.single<T>(query, params);
  }

  /**
   * Every matching row, or one keyset page of them.
   *
   * `page` is optional and the unpaged form emits **byte-identical** SQL to what it always
   * did — no `ORDER BY`, no `LIMIT`. That is deliberate rather than incidental: every
   * owner-scoped caller is already bounded by its citizenid predicate, several
   * `repositoryFactory` subclasses call `super.findAll(where)`, and `Repository.test.ts`
   * asserts on the exact query string. Paging is what a table with no per-player bound
   * needs, and only that table should pay for it.
   *
   * Ordered by `id DESC` when paged, which is not configurable — see `PagingDefinition`
   * for why all four of its properties (clustered index, index already emitted,
   * single-column cursor, immunity to edits) come from it being the primary key.
   */
  async findAll(where: Partial<T> = {}, page?: { limit?: number; cursor?: number }): Promise<T[]> {
    const filter = { ...where } as Record<string, unknown>;
    if (this.hasStatusColumn && !('status' in filter)) {
      filter.status = 'active';
    }

    const keys = Object.keys(filter);
    this.assertColumns(keys, 'findAll');
    const values = keys.map((key) => filter[key]);

    const conditions = keys.map((key) => `\`${key}\` = ?`);

    // Strictly less-than, so a cursor names the last row already delivered rather than the
    // first one still to come. Off by one here duplicates a row at every page boundary.
    if (page?.cursor !== undefined) {
      conditions.push('`id` < ?');
      values.push(page.cursor);
    }

    let query = `SELECT * FROM \`${this.tableName}\``;
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    if (page) {
      query += ' ORDER BY `id` DESC';
      if (page.limit !== undefined) {
        query += ' LIMIT ?';
        values.push(page.limit);
      }
    }

    return await Database.query<T[]>(query, values);
  }

  /**
   * Ownership-scoped update. The `citizenid` lands in the WHERE clause, so a row
   * the caller does not own cannot be modified even when they know its id.
   */
  async update(id: number | string, data: Partial<T>, citizenid: string): Promise<boolean> {
    return await this.updateOwned(id, data as Record<string, unknown>, citizenid);
  }

  private async updateOwned(
    id: number | string,
    data: Record<string, unknown>,
    citizenid: string
  ): Promise<boolean> {
    if (!citizenid) {
      throw new Error(`[Repository] update on '${this.tableName}' requires a citizenid.`);
    }
    if (!this.hasOwnerColumn) {
      throw new Error(
        `[Repository] update on '${this.tableName}' cannot scope by owner: no 'citizenid' column.`
      );
    }
    return await this.applyUpdate(id, data, citizenid);
  }

  /**
   * Update without an ownership predicate.
   *
   * `protected` on purpose. Privileged writes — an admin acting on a shared row,
   * a system dispatch — must be exposed as a named method on the repository that
   * has already authorized the write. A controller cannot reach this directly,
   * which keeps `update` the only generic mutation path.
   */
  protected async updateUnscoped(id: number | string, data: Partial<T>): Promise<boolean> {
    return await this.applyUpdate(id, data as Record<string, unknown>);
  }

  private async applyUpdate(
    id: number | string,
    data: Record<string, unknown>,
    citizenid?: string
  ): Promise<boolean> {
    const { keys, values } = this.prepareColumns(data, 'update');
    const setClause = keys.map((key) => `\`${key}\` = ?`).join(', ');

    let query = `UPDATE \`${this.tableName}\` SET ${setClause} WHERE \`id\` = ?`;
    const params: unknown[] = [...values, id];

    if (citizenid) {
      query += ' AND `citizenid` = ?';
      params.push(citizenid);
    }

    return await Database.update(query, params);
  }

  /**
   * Ownership-scoped soft delete. Rows are never removed — `status` moves to
   * `deleted` so moderation and audit history stay intact.
   */
  async delete(id: number | string, citizenid: string): Promise<boolean> {
    if (!this.hasStatusColumn) {
      throw new Error(
        `[Repository] delete on '${this.tableName}' requires a 'status' column for soft delete.`
      );
    }
    return await this.updateOwned(id, { status: 'deleted' }, citizenid);
  }
}
