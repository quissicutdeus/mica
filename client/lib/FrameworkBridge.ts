export class FrameworkBridge {
  public static getPlayerData(): any {
    try {
      if (exports['qbx_core']?.GetPlayerData) {
        return exports['qbx_core'].GetPlayerData();
      } else if (exports['qb-core']?.GetCoreObject) {
        return exports['qb-core'].GetCoreObject().Functions.GetPlayerData();
      }
    } catch (error) {
      console.error('[FrameworkBridge] Error getting client PlayerData:', error);
      return null;
    }
    return null;
  }

  public static getBankBalance(): number {
    // Separate try/catch from the PlayerData fallback below: FiveM's `exports` proxy
    // throws on property access for an export a resource does not register, so
    // `exports['qbx_core']?.GetMoney` throws rather than evaluating to `undefined` when
    // this qbx_core build has no `GetMoney` export. Letting that escape into the outer
    // try would skip the fallback entirely and always report a balance of 0. Not
    // covered by a test: `exports` is a FiveM runtime global that Vite shadows with a
    // per-module object (see `server/__tests__/BankingBridge.test.ts`), so a missing
    // export cannot be faked from a test — verifying this needs a running server.
    try {
      if (exports['qbx_core']?.GetMoney) {
        const balance = exports['qbx_core'].GetMoney('bank');
        if (typeof balance === 'number') {
          return balance;
        }
      }
    } catch {
      // No GetMoney export on this qbx_core build — fall through to PlayerData below.
    }

    try {
      const playerData = FrameworkBridge.getPlayerData();
      return playerData?.money?.bank ?? 0;
    } catch (error) {
      console.error('[FrameworkBridge] Error getting bank balance:', error);
      return 0;
    }
  }

  public static getCitizenId(): string | null {
    try {
      const playerData = FrameworkBridge.getPlayerData();
      return playerData?.citizenid ?? null;
    } catch (error) {
      console.error('[FrameworkBridge] Error getting citizenid:', error);
      return null;
    }
  }

  public static getPhoneNumber(): string | null {
    try {
      const playerData = FrameworkBridge.getPlayerData();
      return playerData?.charinfo?.phone ?? null;
    } catch (error) {
      console.error('[FrameworkBridge] Error getting phone number:', error);
      return null;
    }
  }
}
