// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEVICES, type DeviceId } from '@mica/shared/devices';
import { sendNuiMessage } from './nui';
import { DeviceState } from './DeviceState';
import { sendChargeToNui } from '../services/Battery';
import { DeviceAnimation } from '../game/DeviceAnimation';
import { Freelook } from '../game/Freelook';
import { PhoneCamera } from '../game/PhoneCamera';
import { requestDeviceItemCheck } from '../services/DeviceItem';

/**
 * The open/close sequence the toggle command used to own outright, factored out so
 * `SetPhoneEnabled`, `OpenApp` (`services/Shell.ts`) and an incoming call can reach it too.
 *
 * Lives in `lib/` rather than `client.ts` itself so both `client.ts` and `services/Shell.ts`
 * can import it — `client.ts` imports `./services` at its top, so the reverse import would
 * be circular.
 *
 * Per device since MICA-262. Raising one device lowers the other first: NUI focus is
 * process-global and there is one page, so two frames can never be up at once, and the
 * web side (`state/device.ts`) assumes exactly that.
 */

/**
 * How often the game clock is read while a device is up. A game minute passes about every
 * two real seconds, so a reading this often is never more than a second late.
 */
const CLOCK_POLL_MS = 1000;

let clockTimer: ReturnType<typeof setInterval> | null = null;
/** The last `hours * 60 + minutes` sent, so a reading that has not moved sends nothing. */
let lastClock: number | null = null;

/**
 * The status-bar clock (MICA-371). Sent only when the minute changed — the poll is faster
 * than the game clock, so about half the readings repeat — or when `force`d on open, since
 * the page may have been showing another device's last time or none at all.
 */
const sendTimeToNui = (force: boolean): void => {
  const hours = GetClockHours();
  const minutes = GetClockMinutes();
  const clock = hours * 60 + minutes;
  if (!force && clock === lastClock) return;
  lastClock = clock;
  sendNuiMessage('setTime', { hours, minutes });
};

/** Runs only while a device is up: `client.ts`'s interval used to tick for the whole session. */
const startClock = (): void => {
  sendTimeToNui(true);
  if (clockTimer === null) clockTimer = setInterval(() => sendTimeToNui(false), CLOCK_POLL_MS);
};

const stopClock = (): void => {
  if (clockTimer !== null) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
};

export const openDevice = (id: DeviceId): void => {
  const other = DeviceState.openDevice();
  if (other && other !== id) closeDevice(other);

  const descriptor = DEVICES[id];
  DeviceState.setOpen(id, true);
  SetNuiFocus(true, true);
  sendNuiMessage('setVisible', { device: id, visible: true });

  const ped = PlayerPedId();
  void DeviceAnimation.playIdle(ped, descriptor);
  DeviceAnimation.spawnProp(ped, descriptor);

  startClock();
  sendChargeToNui(id);
};

export const closeDevice = (id: DeviceId): void => {
  const descriptor = DEVICES[id];
  DeviceState.setOpen(id, false);
  stopClock();

  const ped = PlayerPedId();
  // Only the phone has a camera to put down; the scripted cam is never up for the tablet.
  if (descriptor.chrome.camera) PhoneCamera.disable();
  DeviceAnimation.removeProp();
  DeviceAnimation.stopAll(ped);
  Freelook.resetFreelook();

  sendNuiMessage('setVisible', { device: id, visible: false });
};

/** Lower whatever is up — `hideFrame` and Escape do not say which, and need not. */
export const closeOpenDevice = (): void => {
  const open = DeviceState.openDevice();
  if (open) closeDevice(open);
};

/**
 * The toggle behind each device's key (MICA-262), and behind the client export of the same
 * name (MICA-224). Pressing the key of the device that is open closes it; pressing the key
 * of a closed one opens it, unless it is disabled, in which case nothing opens.
 */
export const toggleDevice = (id: DeviceId): void => {
  // Belt and braces alongside the dispatcher's own guard: whatever key ends up bound
  // to this, it must never fire out from under a focused text field.
  if (DeviceState.isTyping()) return;
  if (DeviceState.isOpen(id)) {
    closeDevice(id);
    return;
  }
  // A disabled device refuses to open at all; closing it is always allowed.
  if (!DeviceState.isEnabled(id)) {
    // MICA-229: a refusal for want of the item is the moment to make sure the server's
    // last word is current -- an inventory event can be missed, and this costs one request.
    requestDeviceItemCheck();
    return;
  }
  openDevice(id);
};

/**
 * Confiscate or return a device: the one flag both the server's `SetPhoneEnabled` push and
 * the client export of that name set (MICA-224), so the two sides agree whichever spoke
 * last. Disabling a device that is open puts it down; enabling one opens nothing.
 */
export const setDeviceEnabled = (id: DeviceId, enabled: boolean): void => {
  DeviceState.setEnabled(id, enabled);
  if (!DeviceState.isEnabled(id) && DeviceState.isOpen(id)) closeDevice(id);
};
