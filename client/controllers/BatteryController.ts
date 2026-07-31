// Client Battery Controller

let phoneCharge = 100;
// Battery deterioration rate in percent per minute (e.g. 1.0 = 1% per minute). Easily updated for real-world scenarios.
export const DRAIN_RATE_PER_MINUTE = 1.0;
let saveCounter = 0;

export const getPhoneCharge = (): number => phoneCharge;

export const sendChargeToNui = () => {
  SendNuiMessage(
    JSON.stringify({
      action: 'setCharge',
      data: phoneCharge
    })
  );
};

export const setPhoneCharge = (amount: number) => {
  const prevCharge = phoneCharge;
  phoneCharge = Math.max(0, Math.min(100, amount));
  sendChargeToNui();

  // Auto-hangup active call when battery reaches 0%
  if (prevCharge > 0 && phoneCharge <= 0) {
    onBatteryDrained();
  }
};

const onBatteryDrained = () => {
  // End active phone call if battery dies
  TriggerServerEvent('gphone:server:endCall');
  try {
    if (exports['pma-voice']?.removePlayerFromCall) {
      exports['pma-voice'].removePlayerFromCall();
    }
  } catch (e) {
    // pma-voice not loaded or active
  }

  // Notify UI of call reset
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'idle' }
    })
  );
};

// Listen for server recharge events
onNet('gphone:client:rechargePhone', () => {
  setPhoneCharge(100);
  TriggerServerEvent('gphone:server:saveBattery', 100);
});

onNet('gphone:client:setCharge', (amount: number) => {
  setPhoneCharge(amount);
});

// Load initial battery state on spawn/join
setTimeout(() => {
  TriggerServerEvent('gphone:server:loadBattery');
}, 1000);

// Deteriorate battery by DRAIN_RATE_PER_MINUTE every minute (sub-percent updates every second)
setInterval(() => {
  if (phoneCharge > 0) {
    const prevLevel = Math.ceil(phoneCharge);
    phoneCharge = Math.max(0, phoneCharge - DRAIN_RATE_PER_MINUTE / 60);
    sendChargeToNui();

    if (phoneCharge <= 0 && prevLevel > 0) {
      onBatteryDrained();
    }

    // Save charge level to server every 15 seconds
    saveCounter++;
    if (saveCounter >= 15) {
      saveCounter = 0;
      TriggerServerEvent('gphone:server:saveBattery', phoneCharge);
    }
  }
}, 1000);
