export interface FrameworkPlayer {
  citizenid: string;
  source: number;
  phone?: string;
  getMoney(type: 'bank' | 'cash'): number;
  removeMoney(type: 'bank' | 'cash', amount: number): boolean;
  setMeta(key: string, value: any): void;
  removeItem(item: string, count: number): boolean;
  rawPlayer: any;
}

export class FrameworkBridge {
  public static getPlayer(src: number): FrameworkPlayer | null {
    try {
      // QBX Core
      if (exports['qbx_core']?.GetPlayer) {
        const player = exports['qbx_core'].GetPlayer(src);
        if (!player) return null;
        const citizenid = player.PlayerData?.citizenid || player.citizenid || `src_${src}`;
        const phone = player.PlayerData?.charinfo?.phone || null;
        return {
          citizenid,
          source: src,
          phone,
          getMoney: (type: 'bank' | 'cash') => {
            if (player.Functions?.GetMoney) return player.Functions.GetMoney(type);
            if (exports['qbx_core']?.GetMoney) return exports['qbx_core'].GetMoney(src, type);
            return player.PlayerData?.money?.[type] ?? 0;
          },
          removeMoney: (type: 'bank' | 'cash', amount: number) => {
            if (player.Functions?.RemoveMoney) return player.Functions.RemoveMoney(type, amount);
            return false;
          },
          setMeta: (key: string, value: any) => {
            if (player.Functions?.SetMetaData) {
              player.Functions.SetMetaData(key, value);
            } else if (player.PlayerData?.metadata) {
              player.PlayerData.metadata[key] = value;
            }
            try {
              if (exports['qbx_core']?.SetMetaData) {
                exports['qbx_core'].SetMetaData(src, key, value);
              }
            } catch (e) {
              // ignore
            }
          },
          removeItem: (item: string, count: number) => {
            return FrameworkBridge.removeInventoryItem(src, player, item, count);
          },
          rawPlayer: player
        };
      }

      // QB Core
      if (exports['qb-core']?.GetCoreObject) {
        const QBCore = exports['qb-core'].GetCoreObject();
        const player = QBCore?.Functions?.GetPlayer ? QBCore.Functions.GetPlayer(src) : null;
        if (!player) return null;
        const citizenid = player.PlayerData?.citizenid || `src_${src}`;
        const phone = player.PlayerData?.charinfo?.phone || null;
        return {
          citizenid,
          source: src,
          phone,
          getMoney: (type: 'bank' | 'cash') =>
            player.Functions?.GetMoney
              ? player.Functions.GetMoney(type)
              : (player.PlayerData?.money?.[type] ?? 0),
          removeMoney: (type: 'bank' | 'cash', amount: number) =>
            player.Functions?.RemoveMoney ? player.Functions.RemoveMoney(type, amount) : false,
          setMeta: (key: string, value: any) => {
            if (player.Functions?.SetMetaData) {
              player.Functions.SetMetaData(key, value);
            } else if (player.PlayerData?.metadata) {
              player.PlayerData.metadata[key] = value;
            }
          },
          removeItem: (item: string, count: number) => {
            return FrameworkBridge.removeInventoryItem(src, player, item, count);
          },
          rawPlayer: player
        };
      }
    } catch (error) {
      console.error('[FrameworkBridge] Error getting player:', error);
    }
    return null;
  }

  public static getCitizenId(src: number): string | null {
    const player = FrameworkBridge.getPlayer(src);
    return player ? player.citizenid : null;
  }

  public static getPlayerPhone(src: number): string | null {
    const player = FrameworkBridge.getPlayer(src);
    return player?.phone || null;
  }

  public static getAllPlayers(): Record<string | number, any> {
    try {
      if (exports['qbx_core']?.GetQBPlayers) {
        return exports['qbx_core'].GetQBPlayers() || {};
      } else if (exports['qb-core']?.GetCoreObject) {
        const QBCore = exports['qb-core'].GetCoreObject();
        return QBCore?.Functions?.GetQBPlayers ? QBCore.Functions.GetQBPlayers() : {};
      }
    } catch (error) {
      console.error('[FrameworkBridge] Error fetching all players:', error);
    }
    return {};
  }

  public static getPlayerByPhone(phone: string): FrameworkPlayer | null {
    try {
      const players = FrameworkBridge.getAllPlayers();
      for (const src in players) {
        const targetPlayer = players[src];
        if (targetPlayer?.PlayerData?.charinfo?.phone === phone) {
          return FrameworkBridge.getPlayer(parseInt(src, 10));
        }
      }
    } catch (error) {
      console.error(`[FrameworkBridge] Error finding player by phone ${phone}:`, error);
    }
    return null;
  }

  public static removeInventoryItem(
    src: number,
    player: any,
    item: string,
    count: number
  ): boolean {
    if (player?.Functions?.RemoveItem) {
      return player.Functions.RemoveItem(item, count);
    }
    try {
      if (exports['ox_inventory']?.RemoveItem) {
        return exports['ox_inventory'].RemoveItem(src, item, count);
      }
    } catch (e) {
      // ox_inventory not present
    }
    return true; // Fallback allow if inventory item removal function not detected
  }

  public static registerUsableItem(item: string, cb: (source: number) => void): void {
    try {
      if (exports['qbx_core']?.CreateUseableItem) {
        exports['qbx_core'].CreateUseableItem(item, cb);
      } else if (exports['qb-core']?.GetCoreObject) {
        const QBCore = exports['qb-core'].GetCoreObject();
        if (QBCore?.Functions?.CreateUseableItem) {
          QBCore.Functions.CreateUseableItem(item, cb);
        }
      }
    } catch (error) {
      console.error(`[FrameworkBridge] Framework item registration skipped for '${item}':`, error);
    }
  }
}
