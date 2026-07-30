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
        try {
            if (exports['qbx_core']?.GetMoney) {
                const balance = exports['qbx_core'].GetMoney('bank');
                if (typeof balance === 'number') {
                    return balance;
                }
            }
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
