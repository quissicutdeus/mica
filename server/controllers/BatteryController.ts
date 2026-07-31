// Server Battery Controller
import { FrameworkBridge } from '../lib/FrameworkBridge';

// In-memory battery store by citizenid / source fallback
const playerBatteryStore: Record<string, number> = {};

// Helper to remove item from inventory
const removeBatteryBankItem = (src: number): boolean => {
  const player = FrameworkBridge.getPlayer(src);
  if (!player) return true;
  return player.removeItem('battery_bank', 1);
};

// Helper to save battery level into player metadata
const setPlayerBatteryMeta = (src: number, level: number) => {
  const player = FrameworkBridge.getPlayer(src);
  const citizenid = player?.citizenid || `src_${src}`;
  const safeLevel = Math.max(0, Math.min(100, level));
  playerBatteryStore[citizenid] = safeLevel;

  if (player) {
    player.setMeta('gphone_battery', safeLevel);
  }
};

// Event handler for battery_bank item or custom server trigger to recharge phone
onNet('gphone:server:useBatteryBank', () => {
  const src = source;
  const removed = removeBatteryBankItem(src);
  if (removed) {
    setPlayerBatteryMeta(src, 100);
    emitNet('gphone:client:rechargePhone', src);
  }
});

// Event to save battery charge from client
onNet('gphone:server:saveBattery', (chargeAmount: number) => {
  const src = source;
  setPlayerBatteryMeta(src, chargeAmount);
});

// Helper function to send battery charge to client from metadata
const sendLoadedBatteryToClient = (src: number) => {
  const player = FrameworkBridge.getPlayer(src);
  const citizenid = player?.citizenid || `src_${src}`;

  let savedCharge = 100;
  const rawPlayer = player?.rawPlayer;
  if (rawPlayer?.PlayerData?.metadata?.gphone_battery !== undefined) {
    savedCharge = rawPlayer.PlayerData.metadata.gphone_battery;
  } else if (rawPlayer?.PlayerData?.metadata?.phone_battery !== undefined) {
    savedCharge = rawPlayer.PlayerData.metadata.phone_battery;
  } else if (playerBatteryStore[citizenid] !== undefined) {
    savedCharge = playerBatteryStore[citizenid];
  }
  emitNet('gphone:client:setCharge', src, savedCharge);
};

// Event for client to request saved battery level on spawn / join
onNet('gphone:server:loadBattery', () => {
  sendLoadedBatteryToClient(source);
});

// Listen for QBX / QBCore character load events
on('QBCore:Server:OnPlayerLoaded', (player: any) => {
  const src = typeof player === 'number' ? player : player?.PlayerData?.source;
  if (src) {
    sendLoadedBatteryToClient(src);
  }
});

// Listen for QBX core player loaded event
on('qbx_core:server:playerLoaded', (player: any) => {
  const src = typeof player === 'number' ? player : player?.PlayerData?.source;
  if (src) {
    sendLoadedBatteryToClient(src);
  }
});

// Register usable item with framework
FrameworkBridge.registerUsableItem('battery_bank', (source: number) => {
  const removed = removeBatteryBankItem(source);
  if (removed) {
    emitNet('gphone:client:rechargePhone', source);
  }
});
