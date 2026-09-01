// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { PlayerFacingError } from './errors';
import type { ColumnRule, ResolvedMembership } from './defineService';

/**
 * Columns no client payload may ever write, on any table.
 *
 * `id` is the primary key, `citizenid` is the ownership anchor and is always
 * supplied by the server from the framework, `status` drives soft-delete and
 * moderation and is moved only by named repository methods (`delete`, a
 * moderation sweep), and the timestamps are managed by MySQL. A repository
 * that lists any of these in `clientWritable` still will not get them — this
 * set is subtracted last.
 *
 * `defineService` already refuses to let a schema declare `status` (it is an
 * `IMPLICIT_COLUMNS` name), so a declared service never reaches this backstop
 * for it. This entry is what actually holds the line for §2.9's other case —
 * "hand-written otherwise" — where a repository sets `clientWritable` directly
 * and passes through no declaration that could vet it.
 */
const NEVER_CLIENT_WRITABLE = new Set(['id', 'citizenid', 'status', 'created_at', 'updated_at']);

/**
 * Columns no client may filter on, whatever a repository declares. Subtracted last, exactly
 * as `NEVER_CLIENT_WRITABLE` is, and here for the same reason that one is: **a hand-written
 * repository sets `clientFilterable` directly** and passes through no declaration that could
 * vet it. A `defineService` table is already covered upstream and does not need this — see
 * below — so this set is aimed squarely at the other half of §2.9's "derived for declared
 * apps, hand-written otherwise".
 *
 * Shorter than the never-writable set, and deliberately not a copy of it: filtering by `id`
 * is an ordinary single-row lookup and a timestamp is not a secret. Two columns earn a
 * blanket refusal, each for its own reason.
 *
 * - **`citizenid`** — the projection is what keeps an owner off a public row (see
 *   `publicColumns`), and a filter walks straight around it. `WHERE citizenid = ?` plus a row
 *   count answers "which of these accounts are the same person's" without the column ever
 *   being selected, which is the alt-account correlation the projection exists to prevent.
 * - **`status`** — `findAll` supplies `'active'` *only when the filter does not name it*, so a
 *   filterable `status` is a client-supplied override: ask for `'deleted'` or `'moderated'`
 *   and the soft-delete and the moderation sweep both read back.
 *
 * **What actually protects a derived table, so nobody mistakes this for it:** both names are
 * in `IMPLICIT_COLUMNS`, and `resolveAppSchema` throws if a schema declares one. Neither can
 * become a `field`, so no derivation in `defineService` can put it in `clientFilterable` —
 * which was true before MICA-137 decoupled filtering from writing and is untouched by it.
 */
const NEVER_CLIENT_FILTERABLE = new Set(['citizenid', 'status']);

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

  /**
   * Columns a client payload may filter on through the generic `get` path.
   * Independent of `clientWritable`; `NEVER_CLIENT_FILTERABLE` is subtracted last.
   */
  protected clientFilterable: readonly string[] = [];

  /**
   * How membership is decided for this table, when ownership is the wrong question.
   * Null unless the service declared it. See `isMember`.
   */
  protected membership: ResolvedMembership | null = null;

  /**
   * What a client-supplied value for each column has to look like, derived from the schema.
   * Empty for a hand-written repository, which then gets no length checking.
   */
  protected columnRules: Record<string, ColumnRule> = {};

  /** Seconds an owner may still edit a row for; null for unlimited. See `applyUpdate`. */
  protected editWindow: number | null = null;

  /**
   * Reject a client-supplied value the column cannot actually hold.
   *
   * The declaration has always carried the answer — `length: 50`, `values: [...]` — and
   * nothing read it: both reached the DDL and stopped there. So the generic write path would
   * hand MySQL a 10,000-character value for a `varchar(50)`, and MySQL decides. In non-strict
   * mode it **silently truncates**: the row is written, the write reports success, and the
   * data is quietly wrong — the exact failure shape this codebase keeps deleting. In strict
   * mode it errors, and the player is told "Unknown error".
   *
   * Enum is worth the check for a different reason. `status` is never client-writable, but an
   * app declaring its own enum column gets the database constraint *and* a readable rejection
   * rather than MySQL's, which for an out-of-range enum in non-strict mode is the empty string.
   */
  public assertWritableValue(column: string, value: unknown): void {
    const rule = this.columnRules[column];
    if (!rule || value === null || value === undefined) return;

    /**
     * These messages reach **players**, not developers, which is easy to miss.
     * `ServiceEndpoint` forwards them and `useAppAction` shows them in a toast — so no
     * `[Repository]` prefix and no table name. Every other throw in this class is a
     * programming error the player can never trigger; these are the ones an ordinary long
     * contact name reaches, and `PlayerFacingError` is now what says which is which. Before
     * it, every throw in this file left the server through the same line as these four.
     */
    if (rule.values && !rule.values.includes(String(value))) {
      throw new PlayerFacingError(`'${column}' must be one of: ${rule.values.join(', ')}.`);
    }

    if (rule.maxLength !== null && typeof value === 'string' && value.length > rule.maxLength) {
      throw new PlayerFacingError(`'${column}' is limited to ${rule.maxLength} characters.`);
    }

    if (rule.type === 'int' && typeof value === 'number' && !Number.isInteger(value)) {
      throw new PlayerFacingError(`'${column}' must be a whole number.`);
    }

    /**
     * `int(11)` is a signed 32-bit MySQL `INT` (`INT_MIN`/`INT_MAX` in `defineService.ts`).
     * Out of range, non-strict MySQL **silently clamps** to the boundary rather than
     * erroring — the write reports success and the stored value is not the one sent. The
     * whole-number check above catches a fraction; this catches a value that is an integer
     * but does not fit.
     */
    if (
      rule.type === 'int' &&
      typeof value === 'number' &&
      Number.isInteger(value) &&
      rule.min !== null &&
      rule.max !== null &&
      (value < rule.min || value > rule.max)
    ) {
      throw new PlayerFacingError(`'${column}' must be between ${rule.min} and ${rule.max}.`);
    }
  }

  public get tableColumns(): readonly string[] {
    return this.columns;
  }

  public get writableColumns(): readonly string[] {
    return this.clientWritable.filter(
      (column) => !NEVER_CLIENT_WRITABLE.has(column) && this.columns.includes(column)
    );
  }

  public get filterableColumns(): readonly string[] {
    return this.clientFilterable.filter(
      (column) => !NEVER_CLIENT_FILTERABLE.has(column) && this.columns.includes(column)
    );
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
  async findAll(
    where: Partial<T> = {},
    page?: { limit?: number; cursor?: number },
    /**
     * Columns to select instead of `*`.
     *
     * Only a public read passes one, and it passes `publicColumns` — which never contains
     * `citizenid`. Withholding it in the **projection** rather than by dropping the key from
     * the returned rows is deliberate: a `repositoryFactory` override that re-shapes results
     * cannot re-add a column the query never asked for.
     *
     * Every name is checked against the table's own allowlist first, for the reason §2.9
     * gives: MySQL cannot parameterize an identifier, so anything interpolated has to be
     * something this table actually has.
     */
    projection?: readonly string[]
  ): Promise<T[]> {
    const filter = { ...where } as Record<string, unknown>;
    if (this.hasStatusColumn && !('status' in filter)) {
      filter.status = 'active';
    }

    const keys = Object.keys(filter);
    this.assertColumns(keys, 'findAll');
    /**
     * `null` means IS NULL, not `= NULL`.
     *
     * SQL's `= NULL` is never true, so a filter of `{ reply_to: null }` — the obvious way to
     * ask for top-level posts — silently matched nothing and rendered an empty list. Latent for
     * every nullable filterable column, and invisible: no error, just no rows.
     */
    const conditions: string[] = [];
    const bound: unknown[] = [];
    for (const key of keys) {
      if (filter[key] === null) {
        conditions.push(`\`${key}\` IS NULL`);
      } else {
        conditions.push(`\`${key}\` = ?`);
        bound.push(filter[key]);
      }
    }

    // Strictly less-than, so a cursor names the last row already delivered rather than the
    // first one still to come. Off by one here duplicates a row at every page boundary.
    if (page?.cursor !== undefined) {
      conditions.push('`id` < ?');
      bound.push(page.cursor);
    }

    let selection = '*';
    if (projection && projection.length > 0) {
      this.assertColumns([...projection], 'findAll projection');
      selection = projection.map((column) => `\`${column}\``).join(', ');
    }

    let query = `SELECT ${selection} FROM \`${this.tableName}\``;
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    if (page) {
      query += ' ORDER BY `id` DESC';
      if (page.limit !== undefined) {
        query += ' LIMIT ?';
        bound.push(page.limit);
      }
    }

    return await Database.query<T[]>(query, bound);
  }

  /**
   * Ownership-scoped update. The `citizenid` lands in the WHERE clause, so a row
   * the caller does not own cannot be modified even when they know its id.
   */
  async update(id: number | string, data: Partial<T>, citizenid: string): Promise<boolean> {
    return await this.updateOwned(id, data as Record<string, unknown>, citizenid, true);
  }

  private async updateOwned(
    id: number | string,
    data: Record<string, unknown>,
    citizenid: string,
    /**
     * Whether the service's `editWindow` applies.
     *
     * False for the soft delete, and that distinction is the whole reason this is a parameter
     * rather than read off `this`. Removing your own post has to stay possible forever; the
     * window is about rewriting, not about withdrawing. The first version of this shared one
     * code path and silently made an expired post undeletable.
     */
    enforceEditWindow: boolean
  ): Promise<boolean> {
    if (!citizenid) {
      throw new Error(`[Repository] update on '${this.tableName}' requires a citizenid.`);
    }
    if (!this.hasOwnerColumn) {
      throw new Error(
        `[Repository] update on '${this.tableName}' cannot scope by owner: no 'citizenid' column.`
      );
    }
    return await this.applyUpdate(id, data, citizenid, enforceEditWindow);
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
    citizenid?: string,
    enforceEditWindow = false
  ): Promise<boolean> {
    const { keys, values } = this.prepareColumns(data, 'update');
    const setClause = keys.map((key) => `\`${key}\` = ?`).join(', ');

    let query = `UPDATE \`${this.tableName}\` SET ${setClause} WHERE \`id\` = ?`;
    const params: unknown[] = [...values, id];

    if (citizenid) {
      query += ' AND `citizenid` = ?';
      params.push(citizenid);

      /**
       * An owner may not edit content a moderator has removed.
       *
       * The row stays out of every read (`findAll` filters `status = 'active'`), so this is
       * not a visibility hole on its own — but without it an author can keep rewriting a
       * moderated post, and if a moderator later reinstates it they reinstate text nobody
       * reviewed.
       *
       * Only `moderated`, deliberately. Excluding `deleted` too would make deleting an
       * already-deleted row report failure, and excluding an app's own states — Notes and
       * Conversations both declare `archived` — would break editing a row that is merely put
       * away. Moderation is the one state that is a decision *about* the author.
       *
       * Not applied to `updateUnscoped`: moderating and un-moderating are exactly the writes
       * that have to reach these rows.
       */
      if (this.hasStatusColumn) {
        query += " AND `status` != 'moderated'";
      }

      /**
       * And not after the edit window has closed, when the service declares one.
       *
       * In the same statement rather than a check before it, so there is no gap between
       * deciding and writing. Both sides of the comparison are the database's clock, which is
       * what makes it immune to skew.
       */
      if (enforceEditWindow && this.editWindow !== null && this.columns.includes('created_at')) {
        query += ' AND `created_at` > NOW() - INTERVAL ? SECOND';
        params.push(this.editWindow);
      }
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
    // `enforceEditWindow: false` — see `updateOwned`. The moderation predicate still
    // applies: deleting a moderated row would overwrite the moderation record with 'deleted'.
    return await this.updateOwned(id, { status: 'deleted' }, citizenid, false);
  }

  /**
   * Undo a `delete`, ownership-scoped exactly the same way — a row id is never
   * authorization, so this checks `citizenid` in the same `WHERE` `delete` does — and
   * time-boxed to `windowDays` after the deletion (MICA-75). Past the window this
   * simply matches no row and reports `false`: the row is not gone, it is only no longer
   * reachable through this action, since the moderation system depends on a soft-deleted
   * row surviving forever once the window has closed (a decision this method does not
   * revisit — nothing here ever hard-deletes anything).
   *
   * `updated_at` stands in for "when was this deleted" rather than a dedicated
   * `deleted_at` column: every declared table already carries `ON UPDATE
   * CURRENT_TIMESTAMP` on it, `delete`'s own `UPDATE` bumps it as a side effect with
   * nothing else to write, and adding a real column is a schema change this ticket was
   * not asked for. The one thing this borrows is imprecise if something *else* touches a
   * deleted row afterward (moderation, say) — no path in this codebase does, but a
   * dedicated column would not have that caveat if one ever needs to.
   *
   * A raw query rather than routing through `applyUpdate`: that private method's own
   * window concept (`editWindow`) is keyed on `created_at` and a property fixed at
   * construction, and bending it to also express "keyed on `updated_at`, with a window
   * supplied per call" would make it correct for neither caller. `status`, `citizenid`
   * and `updated_at` are fixed column names this class already knows about, not payload
   * keys, so nothing here reaches `assertColumns`' allowlist and nothing needs to.
   */
  async restore(id: number | string, citizenid: string, windowDays: number): Promise<boolean> {
    if (!this.hasStatusColumn) {
      throw new Error(
        `[Repository] restore on '${this.tableName}' requires a 'status' column for soft delete.`
      );
    }
    if (!this.columns.includes('updated_at')) {
      throw new Error(
        `[Repository] restore on '${this.tableName}' requires an 'updated_at' column.`
      );
    }
    return await Database.update(
      `UPDATE \`${this.tableName}\` SET \`status\` = 'active'
       WHERE \`id\` = ? AND \`citizenid\` = ? AND \`status\` = 'deleted'
         AND \`updated_at\` >= NOW() - INTERVAL ? DAY`,
      [id, citizenid, windowDays]
    );
  }

  /**
   * The player's own "Recently Deleted" list (MICA-75-wiring) — every soft-deleted row
   * `restore` above could still bring back, and nothing past that window.
   *
   * Bounded to the same `windowDays` `restore` itself enforces, deliberately: a row this
   * excludes is a row `restore` would refuse anyway (past the window, its `UPDATE` matches
   * nothing), so nothing shown here is ever a dead end. `RecentlyDeleted.svelte` was built
   * with no countdown or "expires in" copy on purpose — the honest way to keep that promise
   * is for a row to simply stop being listed once it stops being restorable, not to show it
   * with no way to say why Restore no longer works.
   *
   * Ownership-scoped exactly like `restore` — a citizenid in the `WHERE`, never a bare id —
   * and, like `restore`, reached through this named method rather than the generic `findAll`
   * filter path: `status` is in `NEVER_CLIENT_FILTERABLE` up top, so a client payload can
   * never ask for `'deleted'` rows through the ordinary read. This bypasses that path from
   * trusted server code the same way `restore`'s own query does, not around it.
   *
   * `projection` mirrors `findAll`'s own: Media's deleted rows can carry the same full
   * base64 `data` blob MICA-110 stopped shipping on the main list read, and a "Recently
   * Deleted" screen has exactly the same no-need-for-the-original shape that ticket already
   * solved for. Contacts and Notes have no such column and simply never pass one.
   */
  async findDeleted(
    citizenid: string,
    windowDays: number,
    projection?: readonly string[]
  ): Promise<T[]> {
    if (!this.hasStatusColumn) {
      throw new Error(
        `[Repository] findDeleted on '${this.tableName}' requires a 'status' column for soft delete.`
      );
    }
    if (!this.hasOwnerColumn) {
      throw new Error(
        `[Repository] findDeleted on '${this.tableName}' requires a 'citizenid' column.`
      );
    }

    let selection = '*';
    if (projection && projection.length > 0) {
      this.assertColumns([...projection], 'findDeleted projection');
      selection = projection.map((column) => `\`${column}\``).join(', ');
    }

    return await Database.query<T[]>(
      `SELECT ${selection} FROM \`${this.tableName}\`
       WHERE \`citizenid\` = ? AND \`status\` = 'deleted'
         AND \`updated_at\` >= NOW() - INTERVAL ? DAY
       ORDER BY \`updated_at\` DESC`,
      [citizenid, windowDays]
    );
  }
}
