import { Repository } from './Repository';
import { AuditLogger } from './AuditLogger';
import { requirePositiveInt } from './payload';
import { requestEventFor, responseEventFor } from '@shared/rpc';
import { FrameworkBridge, FrameworkPlayer } from './FrameworkBridge';

export interface ServerAppOptions {
  disableGet?: boolean;
  disableCreate?: boolean;
  disableUpdate?: boolean;
  disableDelete?: boolean;
  tableName?: string;
  onAfterDelete?: (citizenid: string, targetId: number) => Promise<void>;
}

export class ServerApp<T> {
  constructor(
    private appName: string,
    /**
     * Null for an app with no gPhone-owned table — Bank reads another resource's
     * export instead. Such an app must disable every generic CRUD action.
     */
    private repo: Repository<T> | null,
    private options: ServerAppOptions = {}
  ) {
    this.registerCrudEvents();
  }

  /** The repository, or a loud failure if a generic action was left enabled without one. */
  private get repository(): Repository<T> {
    if (!this.repo) {
      throw new Error(
        `ServerApp('${this.appName}') has no repository, so generic CRUD is unavailable. ` +
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
  private pickColumns(data: any, allowed: readonly string[]): Record<string, unknown> {
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
        throw new Error(`Field '${column}' on ${this.appName} must be a scalar value.`);
      }
      picked[column] = value;
    }
    return picked;
  }

  /** Reduce a raw NUI payload to the columns this table lets clients write. */
  private sanitizeWrite(data: any): Record<string, unknown> {
    return this.pickColumns(data, this.repository.writableColumns);
  }

  /** Reduce a raw NUI payload to the columns this table lets clients filter on. */
  private sanitizeFilter(data: any): Record<string, unknown> {
    return this.pickColumns(data, this.repository.filterableColumns);
  }

  /** Pull a usable row id out of a payload, accepting `{ id }` or a bare id. */
  private requireId(data: any): number {
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).id : data;
    try {
      return requirePositiveInt(raw, 'numeric id');
    } catch {
      throw new Error(`A valid numeric id is required for this ${this.appName} operation.`);
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
      this.registerEvent('get', async (source: number, cbId: any, data: any, citizenid: string) => {
        const result = await this.repository.findAll({
          ...this.sanitizeFilter(data),
          citizenid
        } as any);
        return result;
      });
    }

    // Create
    if (!this.options.disableCreate) {
      this.registerEvent(
        'create',
        async (source: number, cbId: any, data: any, citizenid: string) => {
          const fields = this.sanitizeWrite(data);
          if (Object.keys(fields).length === 0) {
            throw new Error(`No writable fields supplied for ${this.appName} create.`);
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
        async (source: number, cbId: any, data: any, citizenid: string) => {
          const id = this.requireId(data);
          const fields = this.sanitizeWrite(data);
          if (Object.keys(fields).length === 0) {
            throw new Error(`No writable fields supplied for ${this.appName} update.`);
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
        async (source: number, cbId: any, data: any, citizenid: string) => {
          const id = this.requireId(data);
          const success = await this.repository.delete(id, citizenid);
          if (success) {
            await AuditLogger.log({
              citizenid,
              action: 'deleted',
              controller: this.appName,
              method: 'delete',
              targetId: id,
              targetTable: this.options.tableName || `gphone_${this.appName}`
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
      cbId: any,
      data: any,
      citizenid: string,
      player: FrameworkPlayer
    ) => Promise<any>
  ) {
    // Both names come from shared/rpc.ts so the client derives exactly the same ones.
    const eventName = requestEventFor(this.appName, action);
    const clientEventName = responseEventFor(this.appName, action);

    onNet(eventName, async (cbId: any, data: any) => {
      const src = source;
      try {
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
