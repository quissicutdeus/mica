export interface FrameworkPlayer {
  citizenid: string;
  source: number;
  phone?: string;
  /**
   * A balance, or `-Infinity` when the framework answered with something that is not one.
   *
   * The sentinel is deliberately unaffordable rather than `0`, so a caller comparing
   * `getMoney(...) < amount` refuses at its existing insufficient-funds branch. See `balanceOf`.
   */
  getMoney(type: 'bank' | 'cash'): number;
  /** `true` only when the framework said `true`. Anything else is a refusal — see `moved`. */
  removeMoney(type: 'bank' | 'cash', amount: number): boolean;
  /**
   * Credit a player.
   *
   * Absent until now, which meant money could only ever flow *out* of a player: `getMoney`
   * and `removeMoney` existed and nothing could pay anyone. A marketplace could take from a
   * buyer and had no way to pay the seller, so it was a noticeboard.
   *
   * Fails **closed** like `removeMoney` — returns false when the framework exposes no handler,
   * and equally when it answers with anything but a literal `true` — rather than the fail-open
   * pattern `removeInventoryItem` uses. That trade is defensible for a consumable whose effect
   * already happened; it is not defensible for money, where fail-open means inventing currency.
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

/**
 * Everything below this line exists because `player` is `any` (MICA-133).
 *
 * The declarations on `FrameworkPlayer` — `removeMoney(): boolean`, `getMoney(): number` —
 * were decorative until now. Whatever qbx_core or qb-core handed back was returned straight
 * through, and `any` satisfies every signature, so TypeScript never objected. gPhone pins
 * `@citizenfx/*` exactly and pins neither of those resources: they belong to the operator and
 * move on the operator's schedule, which makes "RemoveMoney went async in the last release" an
 * ordinary event rather than a hypothetical.
 *
 * Every branch of that failure ran fail-open. A promise is truthy, so `!removeMoney(...)` never
 * tripped and `Payments` credited the payee whether or not the debit happened — money creation,
 * with no attacker, no error and no modified client. `Promise < amount` and `undefined < amount`
 * are both `false`, so the insufficient-funds check fell through to the debit the same way.
 *
 * `Payments` already declines to trust the framework's overdraw guard. These two coercions make
 * it decline to trust the framework's *answers* as well, which is the same decision applied one
 * level down.
 */

/** Enough of a description to make a framework upgrade recognisable in a server log. */
const shapeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof (value as { then?: unknown }).then === 'function') return 'a promise';
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : `the number ${value}`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value} (${String(value)})`;
};

/**
 * Did money actually move?
 *
 * Only a literal `true` says so. A result object, a status code, a promise or `undefined` from
 * a renamed method all mean the same thing here — this code cannot tell — and the only safe
 * reading of "cannot tell" is that the move did not happen. Guessing the other way invents
 * currency, which is the one error no later correction fixes.
 *
 * A plain `false` is an ordinary refusal (an overdraw) and is not logged, for the same reason
 * `getPlayer` shouts about a nameless player but not an absent one. Only a *shapeless* answer
 * is evidence the contract moved.
 */
const moved = (result: unknown, call: string, src: number): boolean => {
  if (typeof result === 'boolean') return result;
  console.error(
    `[FrameworkBridge] ${call} for source ${src} answered with ${shapeOf(result)} rather than ` +
      `a boolean. Treating the move as refused — the framework's contract has changed and ` +
      `this cannot tell whether the money moved.`
  );
  return false;
};

/**
 * A balance, or a number that cannot be afforded.
 *
 * `-Infinity` rather than `0` or a throw: every caller asks `balance < amount`, and the sentinel
 * has to make that true for *any* amount, including a zero-cost one, so the refusal lands at the
 * existing insufficient-funds check instead of somewhere new. It is also not a balance anyone
 * could arrive at honestly, so it cannot be confused for one.
 */
const balanceOf = (result: unknown, call: string, src: number): number => {
  if (typeof result === 'number' && Number.isFinite(result)) return result;
  console.error(
    `[FrameworkBridge] ${call} for source ${src} answered with ${shapeOf(result)} rather than ` +
      `a finite number. Reporting the balance as undeterminable, which reads as unaffordable ` +
      `everywhere it is compared.`
  );
  return -Infinity;
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
            if (player.Functions?.GetMoney)
              return balanceOf(player.Functions.GetMoney(type), 'GetMoney', src);
            if (resource('qbx_core')?.GetMoney)
              return balanceOf(resource('qbx_core').GetMoney(src, type), 'qbx_core.GetMoney', src);
            // The player table, which is data rather than a call, and just as capable of
            // holding a string where a number is declared.
            return balanceOf(player.PlayerData?.money?.[type] ?? 0, 'PlayerData.money', src);
          },
          removeMoney: (type: 'bank' | 'cash', amount: number) => {
            if (player.Functions?.RemoveMoney)
              return moved(player.Functions.RemoveMoney(type, amount), 'RemoveMoney', src);
            return false;
          },
          addMoney: (type: 'bank' | 'cash', amount: number) => {
            if (player.Functions?.AddMoney)
              return moved(player.Functions.AddMoney(type, amount), 'AddMoney', src);
            if (resource('qbx_core')?.AddMoney)
              return moved(
                resource('qbx_core').AddMoney(src, type, amount),
                'qbx_core.AddMoney',
                src
              );
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
            } catch {
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
              ? balanceOf(player.Functions.GetMoney(type), 'GetMoney', src)
              : balanceOf(player.PlayerData?.money?.[type] ?? 0, 'PlayerData.money', src),
          removeMoney: (type: 'bank' | 'cash', amount: number) =>
            player.Functions?.RemoveMoney
              ? moved(player.Functions.RemoveMoney(type, amount), 'RemoveMoney', src)
              : false,
          addMoney: (type: 'bank' | 'cash', amount: number) =>
            player.Functions?.AddMoney
              ? moved(player.Functions.AddMoney(type, amount), 'AddMoney', src)
              : false,
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
    } catch {
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
