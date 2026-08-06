import { Repository } from './Repository';
import { AuditLogger } from './AuditLogger';
import { type CallbackId, requirePositiveInt } from './payload';
import { requestEventFor, responseEventFor } from '@shared/rpc';
import { FrameworkBridge, FrameworkPlayer } from './FrameworkBridge';
import { registerService } from './services';
import { allow, installRateLimitCleanup } from './rateLimit';

// Once per process, not once per service: `on('playerDropped')` would otherwise be registered
// thirteen times and do the same sweep thirteen times per disconnect.
installRateLimitCleanup();

export interface ServiceOptions {
  disableGet?: boolean;
  disableCreate?: boolean;
  disableUpdate?: boolean;
  disableDelete?: boolean;
  tableName?: string;
  onAfterDelete?: (citizenid: string, targetId: number) => Promise<void>;
  /**
   * Drop the ownership predicate from the generic `get`, so every active row is readable.
   *
   * Set from `access.read === 'public'`. Plain booleans and numbers rather than an imported
   * `ResolvedService`, because `defineService` imports *this* file and the reverse would be
   * a runtime cycle rather than a type-only one.
   */
  publicRead?: boolean;
  /** Set from a resolved `paging` declaration. Required alongside `publicRead`. */
  paging?: { pageSize: number; maxPageSize: number };
  /**
   * Columns a public read may select. Set from `publicColumns`, which never includes
   * `citizenid` — with several accounts per player it is a de-anonymisation vector.
   */
  publicColumns?: readonly string[];
}

export class ServiceEndpoint<T> {
  constructor(
    private serviceName: string,
    /**
     * Null for a service with no gPhone-owned table — Bank reads another resource's
     * export instead. Such a service must disable every generic CRUD action.
     */
    private repo: Repository<T> | null,
    private options: ServiceOptions = {}
  ) {
    registerService(serviceName);
    this.registerCrudEvents();
  }

  /** The repository, or a loud failure if a generic action was left enabled without one. */
  private get repository(): Repository<T> {
    if (!this.repo) {
      throw new Error(
        `ServiceEndpoint('${this.serviceName}') has no repository, so generic CRUD is unavailable. ` +
          'Disable get/create/update/delete, or supply a repository.'
      );
    }
    return this.repo;
  }

  /**
   * Reduce a raw NUI payload to a set of allowed columns.
   *
   * Iterates the allowlist rather than the payload, so a hostile key never gets
   * inspected at all — it simply has no slot to land in. Values must be scalars:
   * no gphone column takes a structured value, and handing an object or array to
   * the driver as a bound parameter has no well-defined meaning.
   */
  private pickColumns(data: unknown, allowed: readonly string[]): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    if (!data || typeof data !== 'object') return picked;

    for (const column of allowed) {
      const value = (data as Record<string, unknown>)[column];
      if (value === undefined) continue;

      const isScalar =
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean';

      if (!isScalar) {
        throw new Error(`Field '${column}' on ${this.serviceName} must be a scalar value.`);
      }
      picked[column] = value;
    }
    return picked;
  }

  /**
   * Reduce a raw NUI payload to the columns this table lets clients write, and check each
   * surviving value against what the column can actually hold.
   *
   * Two steps, in this order, and the order matters: the allowlist decides *whether* a value
   * gets a slot, and only then is it worth asking whether it fits. Validating first would mean
   * inspecting keys that have no destination.
   */
  private sanitizeWrite(data: unknown): Record<string, unknown> {
    const picked = this.pickColumns(data, this.repository.writableColumns);
    for (const [column, value] of Object.entries(picked)) {
      this.repository.assertWritableValue(column, value);
    }
    return picked;
  }

  /** Reduce a raw NUI payload to the columns this table lets clients filter on. */
  private sanitizeFilter(data: unknown): Record<string, unknown> {
    return this.pickColumns(data, this.repository.filterableColumns);
  }

  /**
   * How many rows this request may have, clamped to what the service declared.
   *
   * A client asking for a million is answered with `maxPageSize` rather than an error: the
   * request is legitimate, only the number is not, and refusing it would make a paged read
   * fail for a caller that simply guessed high. An absent or unparseable limit falls back to
   * `pageSize`, which is the same thing a client that does not care about paging gets.
   */
  private readLimit(data: unknown, paging: { pageSize: number; maxPageSize: number }): number {
    const raw =
      data && typeof data === 'object' ? (data as Record<string, unknown>).limit : undefined;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      return paging.pageSize;
    }
    return Math.min(raw, paging.maxPageSize);
  }

  /**
   * The id the last page ended on, or undefined for the first page.
   *
   * A bare positive integer, and nothing more: the cursor names a position in a result set
   * the caller is already authorized to read, so it needs no signing. What it must never do
   * is name a **column** — the sort column comes from the declaration, and a payload that
   * tries to supply one is ignored rather than honored. That is the whole reason this is an
   * integer through `requirePositiveInt` instead of an opaque encoded string.
   */
  private readCursor(data: unknown): number | undefined {
    const raw =
      data && typeof data === 'object' ? (data as Record<string, unknown>).cursor : undefined;
    if (raw === undefined || raw === null) return undefined;
    try {
      return requirePositiveInt(raw, 'cursor');
    } catch {
      throw new Error(`A cursor for ${this.serviceName} must be a positive row id.`);
    }
  }

  /** Pull a usable row id out of a payload, accepting `{ id }` or a bare id. */
  private requireId(data: unknown): number {
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).id : data;
    try {
      return requirePositiveInt(raw, 'numeric id');
    } catch {
      throw new Error(`A valid numeric id is required for this ${this.serviceName} operation.`);
    }
  }

  /**
   * Fields MySQL fills in on insert. Echoed back so the optimistic object the UI
   * appends to its store is shaped like a real row.
   */
  private serverStampedFields(): Record<string, unknown> {
    const now = new Date().toISOString();
    const stamped: Record<string, unknown> = {};
    const columns = this.repository.tableColumns;

    if (columns.includes('status')) stamped.status = 'active';
    if (columns.includes('created_at')) stamped.created_at = now;
    if (columns.includes('updated_at')) stamped.updated_at = now;
    return stamped;
  }

  private registerCrudEvents() {
    // Read (All or partial)
    if (!this.options.disableGet) {
      this.registerEvent(
        'get',
        async (source: number, cbId: CallbackId, data: unknown, citizenid: string) => {
          const filter = this.sanitizeFilter(data);

          // The ownership predicate is the *default*, and dropping it is opt-in per service
          // rather than per request — a payload cannot ask to see everyone's rows.
          if (!this.options.publicRead) {
            (filter as Record<string, unknown>).citizenid = citizenid;
          }

          // Only a public read narrows the projection; an owner reading their own rows has
          // every business seeing all of them.
          const projection = this.options.publicRead ? this.options.publicColumns : undefined;

          const paging = this.options.paging;
          if (!paging) {
            return await this.repository.findAll(filter as any, undefined, projection);
          }

          const limit = this.readLimit(data, paging);
          const cursor = this.readCursor(data);

          /**
           * Ask for one more row than the page, and use its existence as the answer to
           * "is there more?".
           *
           * The alternative is a COUNT, which is a second query over the same predicate and
           * still races the next insert. Over-fetching by one is exact, and the extra row is
           * dropped rather than returned.
           */
          const rows = await this.repository.findAll(
            filter as any,
            { limit: limit + 1, cursor },
            projection
          );

          const hasMore = rows.length > limit;
          const pageRows = hasMore ? rows.slice(0, limit) : rows;
          const last = pageRows[pageRows.length - 1] as { id?: number } | undefined;

          return {
            rows: pageRows,
            // Null means the end, and the client must be able to tell that apart from "ask
            // again" — a cursor that keeps being handed back is an infinite scroll that
            // never terminates.
            nextCursor: hasMore && typeof last?.id === 'number' ? last.id : null
          };
        }
      );
    }

    // Create
    if (!this.options.disableCreate) {
      this.registerEvent(
        'create',
        async (source: number, cbId: CallbackId, data: unknown, citizenid: string) => {
          const fields = this.sanitizeWrite(data);
          if (Object.keys(fields).length === 0) {
            throw new Error(`No writable fields supplied for ${this.serviceName} create.`);
          }

          const newItem = { ...fields, citizenid };
          const id = await this.repository.create(newItem as any);
          return { ...this.serverStampedFields(), ...newItem, id };
        }
      );
    }

    // Update
    if (!this.options.disableUpdate) {
      this.registerEvent(
        'update',
        async (source: number, cbId: CallbackId, data: unknown, citizenid: string) => {
          const id = this.requireId(data);
          const fields = this.sanitizeWrite(data);
          if (Object.keys(fields).length === 0) {
            throw new Error(`No writable fields supplied for ${this.serviceName} update.`);
          }

          const success = await this.repository.update(id, fields as any, citizenid);
          return success;
        }
      );
    }

    // Delete
    if (!this.options.disableDelete) {
      this.registerEvent(
        'delete',
        async (source: number, cbId: CallbackId, data: unknown, citizenid: string) => {
          const id = this.requireId(data);
          const success = await this.repository.delete(id, citizenid);
          if (success) {
            await AuditLogger.log({
              citizenid,
              action: 'deleted',
              service: this.serviceName,
              method: 'delete',
              targetId: id,
              targetTable: this.options.tableName || `gphone_${this.serviceName}`
            });
            if (this.options.onAfterDelete) {
              await this.options.onAfterDelete(citizenid, id);
            }
          }
          return success;
        }
      );
    }
  }

  public registerEvent(
    action: string,
    handler: (
      source: number,
      cbId: CallbackId,
      data: unknown,
      citizenid: string,
      player: FrameworkPlayer
    ) => Promise<any>
  ) {
    // Both names come from shared/rpc.ts so the client derives exactly the same ones.
    const eventName = requestEventFor(this.serviceName, action);
    const clientEventName = responseEventFor(this.serviceName, action);

    onNet(eventName, async (cbId: CallbackId, data: unknown) => {
      const src = source;
      try {
        /**
         * Before anything else, including the player lookup.
         *
         * `FrameworkBridge.getPlayer` walks the framework's player table, so doing it first
         * would make the flood pay for itself in exactly the way a flood wants. And a caller
         * with no loaded character still has a source and can still emit events.
         *
         * Answered rather than dropped: `fetchNui` waits on a reply and `ServiceProxy` times
         * out after 15 seconds, so silence would cost the honest client a hang and tell it
         * nothing. This is also why the message says what happened — a rate limit that reads
         * as "Unknown error" gets debugged as a bug.
         */
        if (!allow(src, this.serviceName, action)) {
          emitNet(clientEventName, src, cbId, {
            error: `Too many ${this.serviceName} ${action} requests. Slow down and try again.`
          });
          return;
        }

        const player = FrameworkBridge.getPlayer(src);

        if (!player) {
          emitNet(clientEventName, src, cbId, { error: 'Player not authenticated' });
          return;
        }

        const result = await handler(src, cbId, data, player.citizenid, player);

        if (result !== undefined) {
          emitNet(clientEventName, src, cbId, result);
        }
      } catch (error) {
        console.error(`Error in ${eventName}:`, error);
        emitNet(clientEventName, src, cbId, {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }
}
