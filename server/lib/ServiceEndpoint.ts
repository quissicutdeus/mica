// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Repository } from './Repository';
import { AuditLogger } from './AuditLogger';
import { type CallbackId, requirePositiveInt } from './payload';
import { requestEventFor, responseEventFor } from '@mica/shared/rpc';
import { FrameworkBridge, FrameworkPlayer } from './FrameworkBridge';
import { registerCustomAction, registerService } from './services';
import { allow, installRateLimitCleanup } from './rateLimit';
import { type ActionInput, type ContractAction, type ServiceContract } from '@mica/shared/contract';
import { parseInput, SchemaError, type Schema } from '@mica/shared/schema';
import { GENERIC_ERROR_KEY, GENERIC_ERROR_MESSAGE, PlayerFacingError } from './errors';
import { phoneForRequest } from './phoneIdentity';
import { appDisabledError, disabledAppFor } from './ownerConfig';

// Once per process, not once per service: `on('playerDropped')` would otherwise be registered
// thirteen times and do the same sweep thirteen times per disconnect.
installRateLimitCleanup();

export interface ServiceOptions<C extends ServiceContract = ServiceContract> {
  /**
   * This service's custom actions, declared once in `shared/contracts/`.
   *
   * What it buys, in the order the boundary applies them: `registerEvent` refuses at
   * **startup** to register an action the contract does not declare, and at request time it
   * parses the payload through that action's `input` before the handler sees it. The handler
   * then receives a value of a known shape instead of `unknown` plus its own coercion.
   *
   * Absent for a service with no custom actions at all — the CRUD `registerCrudEvents` derives
   * is validated by the write allowlist and `columnRules` instead, and is deliberately not
   * restated here (see `ActionContract`).
   */
  contract?: C;
  /**
   * The rows follow the phone (MICA-282). Set from `ServiceDefinition.deviceOwned`.
   *
   * Every generic action then scopes by the caller's active phone as well as their citizenid
   * — the read filters on it, the create stamps it, update and delete narrow by it — and every
   * handler, generic or custom, is handed it as its sixth argument. Resolved once per request
   * through `phoneForRequest`, *after* authentication: a player with no loaded character has
   * no inventory to hold a phone in.
   */
  deviceOwned?: boolean;
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
  /**
   * Columns the generic `get` may select when the read is **not** public. Set from
   * `listColumns`, and absent unless the schema marks something `private`.
   *
   * An owner-scoped read narrows for a different reason than a public one: not because the
   * caller may not see the column, but because a list has no use for it and it is expensive
   * — `mica_media.data` is a whole base64 photo per row (MICA-110). The row is still the
   * caller's own, so what is withheld here is withheld from the *list*, not from them.
   */
  listColumns?: readonly string[];
}

export class ServiceEndpoint<T, C extends ServiceContract = ServiceContract> {
  constructor(
    private serviceName: string,
    /**
     * Null for a service with no micaOS-owned table — Bank reads another resource's
     * export instead. Such a service must disable every generic CRUD action.
     */
    private repo: Repository<T> | null,
    private options: ServiceOptions<C> = {}
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
   * no mica column takes a structured value, and handing an object or array to
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
        throw new PlayerFacingError(
          `Field '${column}' on ${this.serviceName} must be a scalar value.`,
          {
            key: 'server.endpoint.fieldNotScalar',
            params: { field: column, service: this.serviceName }
          }
        );
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
      throw new PlayerFacingError(`A cursor for ${this.serviceName} must be a positive row id.`, {
        key: 'server.endpoint.badCursor',
        params: { service: this.serviceName }
      });
    }
  }

  /** Pull a usable row id out of a payload, accepting `{ id }` or a bare id. */
  private requireId(data: unknown): number {
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).id : data;
    try {
      return requirePositiveInt(raw, 'id');
    } catch {
      throw new PlayerFacingError(
        `A valid numeric id is required for this ${this.serviceName} operation.`,
        { key: 'server.endpoint.badId', params: { service: this.serviceName } }
      );
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
      this.registerGeneric(
        'get',
        async (
          source: number,
          cbId: CallbackId,
          data: unknown,
          citizenid: string,
          _player: FrameworkPlayer,
          phoneId?: string
        ) => {
          const filter = this.sanitizeFilter(data);

          // The ownership predicate is the *default*, and dropping it is opt-in per service
          // rather than per request — a payload cannot ask to see everyone's rows.
          if (!this.options.publicRead) {
            (filter as Record<string, unknown>).citizenid = citizenid;
          }
          // And the device beside it, on a table that follows the phone (MICA-282): a phone
          // shows its own rows, not every row its holder has on every phone they carry.
          if (phoneId) (filter as Record<string, unknown>).phone_id = phoneId;

          /**
           * Both axes narrow, for different reasons, and each has its own list.
           *
           * A public read withholds what a stranger may not see — `citizenid` above all. An
           * owner read withholds only what the schema marked `private`, which for an
           * owner-scoped table means "too heavy for a list" rather than "secret": the rows
           * are the caller's own and one of them is still readable in full through an
           * action that asks for one. Absent a `private` column this is `undefined` and the
           * query is the `SELECT *` it always was.
           */
          const projection = this.options.publicRead
            ? this.options.publicColumns
            : this.options.listColumns;

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
      this.registerGeneric(
        'create',
        async (
          source: number,
          cbId: CallbackId,
          data: unknown,
          citizenid: string,
          _player: FrameworkPlayer,
          phoneId?: string
        ) => {
          const fields = this.sanitizeWrite(data);
          if (Object.keys(fields).length === 0) {
            throw new PlayerFacingError(
              `No writable fields supplied for ${this.serviceName} create.`,
              { key: 'server.endpoint.noWritableCreate', params: { service: this.serviceName } }
            );
          }

          // Stamped by the server, never read from the payload — `phone_id` is refused by the
          // write allowlist whatever the client sent (MICA-281).
          const newItem = { ...fields, citizenid, ...(phoneId ? { phone_id: phoneId } : {}) };
          const id = await this.repository.create(newItem as any);
          return { ...this.serverStampedFields(), ...newItem, id };
        }
      );
    }

    // Update
    if (!this.options.disableUpdate) {
      this.registerGeneric(
        'update',
        async (
          source: number,
          cbId: CallbackId,
          data: unknown,
          citizenid: string,
          _player: FrameworkPlayer,
          phoneId?: string
        ) => {
          const id = this.requireId(data);
          const fields = this.sanitizeWrite(data);
          if (Object.keys(fields).length === 0) {
            throw new PlayerFacingError(
              `No writable fields supplied for ${this.serviceName} update.`,
              { key: 'server.endpoint.noWritableUpdate', params: { service: this.serviceName } }
            );
          }

          const success = await this.repository.update(id, fields as any, citizenid, phoneId);
          return success;
        }
      );
    }

    // Delete
    if (!this.options.disableDelete) {
      this.registerGeneric(
        'delete',
        async (
          source: number,
          cbId: CallbackId,
          data: unknown,
          citizenid: string,
          _player: FrameworkPlayer,
          phoneId?: string
        ) => {
          const id = this.requireId(data);
          const success = await this.repository.delete(id, citizenid, phoneId);
          if (success) {
            await AuditLogger.log({
              citizenid,
              action: 'deleted',
              service: this.serviceName,
              method: 'delete',
              targetId: id,
              targetTable: this.options.tableName || `mica_${this.serviceName}`
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

  /**
   * Register one of the four CRUD actions this endpoint derives from the column declaration.
   *
   * Separate from the public `registerEvent` because the two are validated by different
   * things, not because they are wired differently. A generic payload is reduced by the
   * `clientWritable` allowlist and checked against `columnRules`, both derived from the
   * schema; restating that as an input contract would be a second source of truth for one
   * table. The distinction is the **registration path**, never the action's name: a service
   * that disables the generic `create` and hand-writes its own is writing a custom action,
   * and it goes through `registerEvent` and needs a contract entry like any other.
   */
  private registerGeneric(
    action: 'get' | 'create' | 'update' | 'delete',
    handler: (
      source: number,
      cbId: CallbackId,
      data: unknown,
      citizenid: string,
      player: FrameworkPlayer,
      phoneId?: string
    ) => Promise<any>
  ) {
    const contract = this.options.contract;
    if (contract?.actions[action]) {
      throw new Error(
        `ServiceEndpoint('${this.serviceName}'): its contract declares '${action}', but this ` +
          'service also registers the generic ' +
          `'${action}' derived from its columns. One action cannot be validated two ways — ` +
          `disable the generic one, or drop '${action}' from the contract.`
      );
    }
    this.bind(action, undefined, handler);
  }

  /**
   * Register a custom action, validated by the contract before the handler sees the payload.
   *
   * Two things happen at **startup**, which is the point: an action the contract does not
   * declare throws here and takes the resource down at boot, rather than becoming a reachable
   * net event nobody wrote a rule for — the state this ticket found the server in ninety-seven
   * times over. And `A` is constrained to the contract's own keys, so the same mistake is a
   * type error before it is ever a runtime one.
   */
  public registerEvent<A extends ContractAction<C>>(
    action: A,
    handler: (
      source: number,
      cbId: CallbackId,
      data: ActionInput<C, A>,
      citizenid: string,
      player: FrameworkPlayer,
      /** The caller's active phone, on a `deviceOwned` service; undefined otherwise (MICA-282). */
      phoneId?: string
    ) => Promise<any>
  ) {
    const contract = this.options.contract;

    if (!contract) {
      throw new Error(
        `ServiceEndpoint('${this.serviceName}') registered the custom action '${action}' ` +
          'without a contract. A registered net event is reachable whether or not anything ' +
          'calls it, so every hand-written action declares what it accepts — in ' +
          `shared/contracts/${this.serviceName}.ts, or beside the service's own ` +
          'defineService call if it belongs to an add-on.'
      );
    }

    const declared = contract.actions[action];
    if (!declared) {
      throw new Error(
        `ServiceEndpoint('${this.serviceName}') registered '${action}', which its contract ` +
          'does not declare. Add it with an input schema, or do not register it.'
      );
    }

    registerCustomAction(this.serviceName, action);
    this.bind(
      action,
      declared.input,
      handler as (
        source: number,
        cbId: CallbackId,
        data: unknown,
        citizenid: string,
        player: FrameworkPlayer,
        phoneId?: string
      ) => Promise<any>
    );
  }

  /** The wiring both paths share: the net event, the limiter, authentication, the reply. */
  private bind(
    action: string,
    input: Schema | undefined,
    handler: (
      source: number,
      cbId: CallbackId,
      data: unknown,
      citizenid: string,
      player: FrameworkPlayer,
      phoneId?: string
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
            error: `Too many ${this.serviceName} ${action} requests. Slow down and try again.`,
            key: 'server.rateLimited'
          });
          return;
        }

        /**
         * An app the owner switched off with `mica_disabled_apps` (MICA-234), refused here
         * rather than in each handler so a custom action is covered as well as generic CRUD.
         * After the limiter, so a flood still pays nothing, and before the player lookup, since
         * the answer is the same for every caller. Only a service one app owns is ever refused —
         * `lib/ownerConfig.ts` has the table, and why a shared one never is.
         */
        const disabledApp = disabledAppFor(this.serviceName);
        if (disabledApp) throw appDisabledError(disabledApp);

        const player = FrameworkBridge.getPlayer(src);

        if (!player) {
          emitNet(clientEventName, src, cbId, {
            error: 'Player not authenticated',
            key: 'server.notAuthenticated'
          });
          return;
        }

        /**
         * Validation slots in **after** authentication and before the handler
         * (`docs/security.md`, "Entry points"), and the order is not cosmetic. Rate limiting
         * comes first so a flood does not pay for a schema walk; the player lookup comes next
         * because a caller with no character has nothing to be authorized as; only then is it
         * worth asking whether what they sent is the shape the handler is about to read.
         *
         * A `SchemaError` from here lands in the catch below and reaches the player as a
         * toast, which is why its messages name a field and never a table.
         */
        const payload = input ? await parseInput(input, data) : data;

        /**
         * Which phone this is for, on a table that follows the phone (MICA-282).
         *
         * After authentication, because a source with no character has no inventory, and
         * after validation, because a payload that is not even the right shape should not
         * cost an inventory read. The resolver throws a `PlayerFacingError` for a player
         * holding no phone on a server that gates on one — it lands in the catch below and
         * reaches them as a toast — and degrades to the citizen's identity phone where no
         * phone identity can be had. `services/Phones.ts` has the three cases.
         */
        const phoneId = this.options.deviceOwned
          ? await phoneForRequest(src, player.citizenid)
          : undefined;

        const result = await handler(src, cbId, payload, player.citizenid, player, phoneId);

        if (result !== undefined) {
          emitNet(clientEventName, src, cbId, result);
        }
      } catch (error) {
        /**
         * Only two kinds of error carry a message a player may read, and this is the whole
         * allowlist: a `PlayerFacingError` a handler raised deliberately, and a `SchemaError`
         * a declaration raised about the payload. See `lib/errors.ts`.
         *
         * Everything else used to leave through this same line with its message intact, which
         * meant the class of an error was invisible on the wire: a driver failure carrying the
         * statement text that failed, and a `Repository` invariant carrying a table name, both
         * reached a toast looking exactly like "You cannot follow yourself." The stack is what
         * a server owner needs and the player needs none of it.
         */
        const disclosable = error instanceof PlayerFacingError || error instanceof SchemaError;
        if (!disclosable) console.error(`Error in ${eventName}:`, error);

        // The key rides beside the text (MICA-216): a client whose catalog knows it says
        // it in the player's language, one that does not shows the English. A `SchemaError`
        // carries no key — its messages name the field and are not catalogued.
        const keyed = error instanceof PlayerFacingError ? error : undefined;
        emitNet(clientEventName, src, cbId, {
          error: disclosable ? error.message : GENERIC_ERROR_MESSAGE,
          key: keyed ? keyed.key : disclosable ? undefined : GENERIC_ERROR_KEY,
          params: keyed?.params
        });
      }
    });
  }
}
