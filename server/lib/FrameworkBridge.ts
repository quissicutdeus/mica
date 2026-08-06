export interface FrameworkPlayer {
  citizenid: string;
  source: number;
  phone?: string;
  getMoney(type: 'bank' | 'cash'): number;
  removeMoney(type: 'bank' | 'cash', amount: number): boolean;
  /**
   * Credit a player.
   *
   * Absent until now, which meant money could only ever flow *out* of a player: `getMoney`
   * and `removeMoney` existed and nothing could pay anyone. A marketplace could take from a
   * buyer and had no way to pay the seller, so it was a noticeboard.
   *
   * Fails **closed** like `removeMoney` — returns false when the framework exposes no handler
   * — rather than the fail-open pattern `removeInventoryItem` uses. That trade is defensible
   * for a consumable whose effect already happened; it is not defensible for money, where
   * fail-open means inventing currency.
   */
  addMoney(type: 'bank' | 'cash', amount: number): boolean;
  setMeta(key: string, value: any): void;
  removeItem(item: string, count: number): boolean;
  rawPlayer: any;
}

/**
 * Another resource's exports.
 *
 * Indirected through a variable for one reason: under Vitest the bundler supplies its
 * own module-scope `exports` binding that shadows FiveM's global, so a test cannot put a
 * fake `qbx_core` where this module will look. Production evaluates exactly the same
 * expression it always did — see `__setResourceLookup`.
 */
type ResourceLookup = (name: string) => any;

let resource: ResourceLookup = (name) => (exports as any)[name];

/** Test seam, like `__resetBatteryCache`. Pass nothing to restore the real lookup. */
export const __setResourceLookup = (fn?: ResourceLookup): void => {
  resource = fn ?? ((name) => (exports as any)[name]);
};

export class FrameworkBridge {
  public static getPlayer(src: number): FrameworkPlayer | null {
    try {
      // QBX Core
      if (resource('qbx_core')?.GetPlayer) {
        const player = resource('qbx_core').GetPlayer(src);
        if (!player) return null;
        const citizenid = player.PlayerData?.citizenid || player.citizenid;
        if (!citizenid) return FrameworkBridge.unidentified(src, 'qbx_core');
        const phone = player.PlayerData?.charinfo?.phone || null;
        return {
          citizenid,
          source: src,
          phone,
          getMoney: (type: 'bank' | 'cash') => {
            if (player.Functions?.GetMoney) return player.Functions.GetMoney(type);
            if (resource('qbx_core')?.GetMoney) return resource('qbx_core').GetMoney(src, type);
            return player.PlayerData?.money?.[type] ?? 0;
          },
          removeMoney: (type: 'bank' | 'cash', amount: number) => {
            if (player.Functions?.RemoveMoney) return player.Functions.RemoveMoney(type, amount);
            return false;
          },
          addMoney: (type: 'bank' | 'cash', amount: number) => {
            if (player.Functions?.AddMoney) return player.Functions.AddMoney(type, amount);
            if (resource('qbx_core')?.AddMoney)
              return resource('qbx_core').AddMoney(src, type, amount);
            return false;
          },
          setMeta: (key: string, value: any) => {
            if (player.Functions?.SetMetaData) {
              player.Functions.SetMetaData(key, value);
            } else if (player.PlayerData?.metadata) {
              player.PlayerData.metadata[key] = value;
            }
            try {
              if (resource('qbx_core')?.SetMetaData) {
                resource('qbx_core').SetMetaData(src, key, value);
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
      if (resource('qb-core')?.GetCoreObject) {
        const QBCore = resource('qb-core').GetCoreObject();
        const player = QBCore?.Functions?.GetPlayer ? QBCore.Functions.GetPlayer(src) : null;
        if (!player) return null;
        const citizenid = player.PlayerData?.citizenid;
        if (!citizenid) return FrameworkBridge.unidentified(src, 'qb-core');
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
          addMoney: (type: 'bank' | 'cash', amount: number) =>
            player.Functions?.AddMoney ? player.Functions.AddMoney(type, amount) : false,
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

  /**
   * A loaded player the framework will not name.
   *
   * This used to synthesise `src_<source>` and carry on. A server id is not an identity:
   * it is assigned per connection and reused, so the next player to be given source 5
   * would have inherited the previous one's contacts, notes and photos — every
   * repository scopes by citizenid and this one looked perfectly valid.
   *
   * Returning null is what a missing player already does, and `ServiceEndpoint` answers
   * it with "Player not authenticated". A phone that refuses to open beats one showing
   * somebody else's messages.
   */
  private static unidentified(src: number, framework: string): null {
    console.error(
      `[FrameworkBridge] ${framework} returned a player for source ${src} with no ` +
        `citizenid. Refusing to serve gPhone data rather than inventing an identity.`
    );
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
      if (resource('qbx_core')?.GetQBPlayers) {
        return resource('qbx_core').GetQBPlayers() || {};
      } else if (resource('qb-core')?.GetCoreObject) {
        const QBCore = resource('qb-core').GetCoreObject();
        return QBCore?.Functions?.GetQBPlayers ? QBCore.Functions.GetQBPlayers() : {};
      }
    } catch (error) {
      console.error('[FrameworkBridge] Error fetching all players:', error);
    }
    return {};
  }

  /**
   * The server id of an online character, or null when they are not connected.
   *
   * Needed to push anything to a specific character — delivering a message, for one.
   * Everything else here goes the other way, from a source to their data.
   */
  public static getSourceByCitizenId(citizenid: string): number | null {
    return FrameworkBridge.getSourcesByCitizenId([citizenid]).get(citizenid) ?? null;
  }

  /**
   * Server ids for many citizenids, from one snapshot.
   *
   * `getSourceByCitizenId` walks `getAllPlayers()` per call, so notifying forty followers was
   * forty full walks. One pass here, and the single lookup is reimplemented on top so there is
   * still only one place that knows the framework's shape.
   */
  public static getSourcesByCitizenId(citizenids: readonly string[]): Map<string, number> {
    const found = new Map<string, number>();
    if (citizenids.length === 0) return found;

    const wanted = new Set(citizenids.filter(Boolean));
    if (wanted.size === 0) return found;

    try {
      const players = FrameworkBridge.getAllPlayers();
      for (const src in players) {
        const citizenid = players[src]?.PlayerData?.citizenid;
        if (citizenid && wanted.has(citizenid)) found.set(citizenid, parseInt(src, 10));
      }
    } catch (error) {
      console.error('[FrameworkBridge] Error resolving sources:', error);
    }
    return found;
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
      if (resource('ox_inventory')?.RemoveItem) {
        return resource('ox_inventory').RemoveItem(src, item, count);
      }
    } catch (e) {
      // ox_inventory not present
    }

    // Deliberate fail-open, said out loud. A server with a framework but no recognized
    // inventory gets the item's effect without the item being consumed; the alternative
    // is a consumable that silently never works. A silent `return true` here reads as
    // "removed" to every caller, which is the same lie `shareContact` used to tell.
    console.warn(
      `[FrameworkBridge] No inventory resource could remove '${item}' for source ${src}. ` +
        `Allowing the action anyway — the item was not consumed.`
    );
    return true;
  }

  public static registerUsableItem(item: string, cb: (source: number) => void): void {
    try {
      if (resource('qbx_core')?.CreateUseableItem) {
        resource('qbx_core').CreateUseableItem(item, cb);
      } else if (resource('qb-core')?.GetCoreObject) {
        const QBCore = resource('qb-core').GetCoreObject();
        if (QBCore?.Functions?.CreateUseableItem) {
          QBCore.Functions.CreateUseableItem(item, cb);
        }
      }
    } catch (error) {
      console.error(`[FrameworkBridge] Framework item registration skipped for '${item}':`, error);
    }
  }
}
