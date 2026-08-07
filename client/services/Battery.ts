// The client half of the battery service.

let phoneCharge = 100;
// Battery deterioration rate in percent per minute (e.g. 1.0 = 1% per minute). Easily updated for real-world scenarios.
const DRAIN_RATE_PER_MINUTE = 1.0;
// Faster than the drain: a charger that took as long as a full day of use to fill the
// phone would read as broken.
const CHARGE_RATE_PER_MINUTE = 10.0;
let saveCounter = 0;

export const sendChargeToNui = () => {
  SendNuiMessage(
    JSON.stringify({
      action: 'setCharge',
      data: phoneCharge
    })
  );
};

const setPhoneCharge = (amount: number) => {
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
  TriggerServerEvent('gphone:server:phone:end');
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
onNet('gphone:client:battery:recharge', () => {
  setPhoneCharge(100);
  TriggerServerEvent('gphone:server:battery:save', 100);
});

onNet('gphone:client:battery:set', (amount: number) => {
  setPhoneCharge(amount);
});

/**
 * Charging reverses the drain loop rather than topping the battery up from outside.
 *
 * A house or a car charger that repeatedly called `AddBatteryCharge` would be fighting the
 * loop below — every second it adds, the loop subtracts, and the visible charge is
 * whichever landed last. One flag read by the loop is the only way the two agree.
 */
let isCharging = false;
onNet('gphone:client:battery:charging', (state: boolean) => {
  isCharging = state === true;
});

/**
 * Set the charge from the phone's Developer Tools.
 *
 * The DevTools slider used to write only to the web store, so the value snapped back
 * within a second when the drain loop pushed the real charge over it, and nothing ever
 * reached the character. This applies it for real and persists it, so the panel
 * matches what it claims to be doing.
 */
RegisterNuiCallbackType('setBatteryLevel');
on('__cfx_nui:setBatteryLevel', (data: { level?: number }, cb: Function) => {
  const level = Math.max(0, Math.min(100, Number(data?.level)));
  if (!Number.isFinite(level)) {
    cb({ ok: false });
    return;
  }

  setPhoneCharge(level);
  // Admin-gated, unlike the drain loop's `saveBattery`. The server rejects a caller
  // without `gphone.admin` and leaves the stored charge alone, so the local value here
  // reverts as soon as the next drain tick reports the truth.
  TriggerServerEvent('gphone:server:admin:setBattery', level);
  cb({ ok: true, level });
});

// Load initial battery state on spawn/join
setTimeout(() => {
  TriggerServerEvent('gphone:server:battery:load');
}, 1000);

// Deteriorate battery by DRAIN_RATE_PER_MINUTE every minute (sub-percent updates every second)
setInterval(() => {
  // Charging runs the loop backwards, and at the same rate, so a phone left on a charger
  // fills in the time it would have taken to empty. The `> 0` guard below is deliberately
  // not extended to charging: a dead phone must still be able to come back.
  if (isCharging) {
    if (phoneCharge < 100) {
      phoneCharge = Math.min(100, phoneCharge + CHARGE_RATE_PER_MINUTE / 60);
      sendChargeToNui();

      saveCounter++;
      if (saveCounter >= 15) {
        saveCounter = 0;
        TriggerServerEvent('gphone:server:battery:save', phoneCharge);
      }
    }
    return;
  }

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
      TriggerServerEvent('gphone:server:battery:save', phoneCharge);
    }
  }
}, 1000);
