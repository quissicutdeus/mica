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

  private registerCrudEvents() {
    // Read (All or partial)
    if (!this.options.disableGet) {
      this.registerEvent('get', async (source: number, cbId: any, data: any, citizenid: string) => {
        const result = await this.repo.findAll({ ...data, citizenid } as any);
        return result;
      });
    }

    // Create
    if (!this.options.disableCreate) {
      this.registerEvent(
        'create',
        async (source: number, cbId: any, data: any, citizenid: string) => {
          const newItem = { ...data, citizenid };
          const id = await this.repo.create(newItem);
          return { ...newItem, id };
        }
      );
    }

    // Update
    if (!this.options.disableUpdate) {
      this.registerEvent(
        'update',
        async (source: number, cbId: any, data: any, citizenid: string) => {
          if (!data.id) throw new Error('ID required for update');
          const success = await this.repo.update(data.id, data);
          return success;
        }
      );
    }

    // Delete
    if (!this.options.disableDelete) {
      this.registerEvent(
        'delete',
        async (source: number, cbId: any, data: any, citizenid: string) => {
          if (!data.id) throw new Error('ID required for delete');
          const success = await this.repo.delete(data.id);
          if (success) {
            await AuditLogger.log({
              citizenid,
              action: 'deleted',
              controller: `${this.appName}Controller`,
              method: 'delete',
              targetId: Number(data.id),
              targetTable: this.options.tableName || `gphone_${this.appName}`
            });
            if (this.options.onAfterDelete) {
              await this.options.onAfterDelete(citizenid, Number(data.id));
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
