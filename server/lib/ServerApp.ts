import { Repository } from './Repository';
import { AuditLogger } from './AuditLogger';
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
    private repo: Repository<T>,
    private options: ServerAppOptions = {}
  ) {
    this.registerCrudEvents();
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
    return this.pickColumns(data, this.repo.writableColumns);
  }

  /** Reduce a raw NUI payload to the columns this table lets clients filter on. */
  private sanitizeFilter(data: any): Record<string, unknown> {
    return this.pickColumns(data, this.repo.filterableColumns);
  }

  /** Pull a usable row id out of a payload, accepting `{ id }` or a bare id. */
  private requireId(data: any): number {
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).id : data;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`A valid numeric id is required for this ${this.appName} operation.`);
    }
    return id;
  }

  /**
   * Fields MySQL fills in on insert. Echoed back so the optimistic object the UI
   * appends to its store is shaped like a real row.
   */
  private serverStampedFields(): Record<string, unknown> {
    const now = new Date().toISOString();
    const stamped: Record<string, unknown> = {};
    const columns = this.repo.tableColumns;

    if (columns.includes('status')) stamped.status = 'active';
    if (columns.includes('created_at')) stamped.created_at = now;
    if (columns.includes('updated_at')) stamped.updated_at = now;
    return stamped;
  }

  private registerCrudEvents() {
    // Read (All or partial)
    if (!this.options.disableGet) {
      this.registerEvent('get', async (source: number, cbId: any, data: any, citizenid: string) => {
        const result = await this.repo.findAll({ ...this.sanitizeFilter(data), citizenid } as any);
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
          const id = await this.repo.create(newItem as any);
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

          const success = await this.repo.update(id, fields as any, citizenid);
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
          const success = await this.repo.delete(id, citizenid);
          if (success) {
            await AuditLogger.log({
              citizenid,
              action: 'deleted',
              controller: `${this.appName}Controller`,
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
    const eventName = `gphone:server:${this.appName}:${action}`;
    const clientEventName = `gphone:client:${this.appName}:${action === 'get' ? 'receive' : action === 'create' ? 'created' : action === 'update' ? 'updated' : action === 'delete' ? 'deleted' : action}`;

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
