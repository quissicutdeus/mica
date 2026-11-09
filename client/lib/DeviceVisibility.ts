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

/**
 * Raise a device: the frame, focus, the prop in hand and the idle, the clock and the charge.
 *
 * All of it or none of it (MICA-467). A throw anywhere in here used to leave whatever had run
 * so far: focus taken with no frame told to show, which traps the player, since the page that
 * would send `hideFrame` is not on screen and focus keeps every key from the game. Now a throw
 * puts the device down again before it goes on to the caller, who logs it as it always did.
 */
export const openDevice = (id: DeviceId): void => {
  try {
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
  } catch (error) {
    try {
      closeDevice(id);
    } catch {
      // The failure that stopped the open is the one worth reporting; the close released focus.
    }
    throw error;
  }
};

/**
 * Lower a device. Every step runs even when one before it throws, and the first throw is
 * rethrown once they all have (MICA-467): focus is released near the end, so a prop that will
 * not delete or an event that will not send used to leave the player held by a frame already
 * marked closed.
 */
export const closeDevice = (id: DeviceId): void => {
  const descriptor = DEVICES[id];
  const failures: unknown[] = [];
  const step = (run: () => void): void => {
    try {
      run();
    } catch (error) {
      failures.push(error);
    }
  };

  step(() => DeviceState.setOpen(id, false));
  // A field in a frame that is down is not being typed in. Only `hideFrame` used to clear this,
  // so a close from a push or an export while a field had focus left the device's own key
  // refusing to raise it again until the page happened to report a blur (MICA-467).
  step(() => DeviceState.setTyping(false));
  step(stopClock);
  // Only the phone has a camera to put down; the scripted cam is never up for the tablet.
  if (descriptor.chrome.camera) step(() => PhoneCamera.disable());
  step(() => DeviceAnimation.removeProp());
  step(() => DeviceAnimation.stopAll(PlayerPedId()));
  step(() => Freelook.resetFreelook());
  step(() => sendNuiMessage('setVisible', { device: id, visible: false }));

  if (failures.length > 0) throw failures[0];
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
