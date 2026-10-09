// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The client half of the battery service.

import { ALL_DEVICES, DEFAULT_DEVICE, isDeviceId, type DeviceId } from '@mica/shared/devices';
import { sendNuiMessage } from '../lib/nui';

/**
 * The last level and charging flag the server sent, per device (MICA-337). Each device has
 * a battery of its own, so a tablet push never touches the phone's number, and the reverse.
 * Both are display only: the server owns the charge and the drain, and this half draws it.
 */
const level = Object.fromEntries(ALL_DEVICES.map((d) => [d, 100])) as Record<DeviceId, number>;
const charging = Object.fromEntries(ALL_DEVICES.map((d) => [d, false])) as Record<
  DeviceId,
  boolean
>;

/**
 * Absent means the phone, so every server build and script from before MICA-337 still
 * lands where it always did. Anything else that is not a device is refused (`null`) rather
 * than defaulted, so a malformed argument cannot paint over the phone's battery.
 */
const deviceOf = (value: unknown): DeviceId | null => {
  if (value === undefined || value === null) return DEFAULT_DEVICE;
  return isDeviceId(value) ? value : null;
};

/**
 * Paint one device's battery into the UI: its level, and whether it is charging. Called on
 * every push and again whenever that device is raised (`DeviceVisibility.openDevice`), so a
 * page that missed a push while the frame was down still shows the server's last word.
 */
export const sendChargeToNui = (device: DeviceId = DEFAULT_DEVICE) => {
  sendNuiMessage('setCharge', { device, level: level[device] });
  sendNuiMessage('setCharging', { device, charging: charging[device] });
};

const setDeviceCharge = (device: DeviceId, amount: number) => {
  const prevCharge = level[device];
  level[device] = Math.max(0, Math.min(100, amount));
  sendNuiMessage('setCharge', { device, level: level[device] });

  if (prevCharge > 0 && level[device] <= 0) {
    onBatteryDrained(device);
  }
};

/**
 * A device just died. Only the phone carries calls, so only a dead phone ends one; a dead
 * tablet has nothing here to put down, and must never reach the phone's call or frame.
 * Neither closes its own frame either: the web paints that device's dead screen (MICA-337).
 */
const onBatteryDrained = (device: DeviceId) => {
  if (device !== 'phone') return;

  // End active phone call if battery dies. The server takes both parties out of the voice
  // channel on `phone:end` (MICA-341), so nothing here asks pma-voice directly.
  TriggerServerEvent('mica:server:phone:end');

  // Notify UI of call reset
  sendNuiMessage('callStatus', { status: 'idle' });
};

/**
 * `mica:client:battery:recharge` is gone (MICA-257).
 *
 * It said "you are now at 100" and then reported that back over
 * `mica:server:battery:save`, an event the server stopped handling when it took ownership of
 * the number — so the emit was dead code that read as if the client still had a say. The
 * hardcoded 100 was the worse half: `mica_battery_item_charge` lets an owner make a battery
 * bank worth 25%, and this would have painted 100 over it until the next whole-percent tick.
 *
 * `applyCharge` already pushes the real level over `battery:set`, so there is one way the
 * charge reaches the phone and it carries the number the server actually stored.
 */
onNet('mica:client:battery:set', (amount: number, device?: DeviceId) => {
  const id = deviceOf(device);
  const value = Number(amount);
  if (!id || !Number.isFinite(value)) return;
  setDeviceCharge(id, value);
});

/**
 * Whether a device is on a charger (MICA-337). The server held this flag and emitted it
 * for a long while with nobody listening here; it now reaches the UI per device.
 */
onNet('mica:client:battery:charging', (isCharging: boolean, device?: DeviceId) => {
  const id = deviceOf(device);
  if (!id) return;
  charging[id] = isCharging === true;
  sendNuiMessage('setCharging', { device: id, charging: charging[id] });
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
on('__cfx_nui:setBatteryLevel', (data: { level?: number; device?: unknown }, cb: Function) => {
  // Reachable from any script in the page (AGENTS.md §7), so the shape is checked here and
  // the server re-checks both the level and the admin ace on its side.
  const device = deviceOf(data?.device);
  const value = Math.max(0, Math.min(100, Number(data?.level)));
  if (!device || !Number.isFinite(value)) {
    cb({ ok: false });
    return;
  }

  setDeviceCharge(device, value);
  // Admin-gated, unlike the drain loop's `saveBattery`. The server rejects a caller
  // without `mica.admin` and leaves the stored charge alone, so the local value here
  // reverts as soon as the next drain tick reports the truth.
  //
  // `admin:setBattery` is a raw event with a strict tuple (`lib/netGuard.ts`): the phone
  // keeps the one-argument form every server build accepts, and only another device
  // appends its id, which needs the server's widened tuple (MICA-337).
  if (device === DEFAULT_DEVICE) TriggerServerEvent('mica:server:admin:setBattery', value);
  else TriggerServerEvent('mica:server:admin:setBattery', value, device);
  cb({ ok: true, level: value, device });
});

// Load initial battery state on spawn/join
setTimeout(() => {
  TriggerServerEvent('mica:server:battery:load');
}, 1000);

/**
 * No timer here any more.
 *
 * The client used to run the drain loop and report its charge to the server every fifteen
 * seconds, which meant a modified client asserted whatever charge it liked. The server
 * ticks it now and pushes whole percents down; this half only draws what it is told.
 *
 * The charging flag went with it as a client state. Reversing the drain is the loop's job,
 * and the loop is on the other side; `battery:charging` above only paints what it decided.
 */
