// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEVICES, isDeviceId, type DeviceId } from '@mica/shared/devices';
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
 * How long an open waits for the page to say it drew the frame (`frameShown`, MICA-475) before
 * it puts the device down again and hands the player their keys back.
 *
 * `SetNuiFocus(true, true)` gives the page every input, so the page's own `hideFrame` is the
 * player's way out. A page that never draws, whether it threw at boot, never loaded, or dropped
 * the `setVisible` it was sent, cannot send one, and nothing else on the client noticed.
 *
 * Fifteen seconds is `ServiceProxy.relay`'s line for a NUI request the other side will never
 * answer, the one the client already draws. A cold first open fits well inside it, because the
 * page loads at resource start, during the join, and never unloads (`services/Settings.ts`). By
 * the time a player can press a key, a first open costs mounting the frame and the launcher,
 * and none of that waits on the server: `bootstrapStores` starts after the frame is up. Erring
 * long is the safe side. A bound that is too short drops a frame that was coming, and the player
 * presses the key again. A bound that is too long only holds a broken page's player longer.
 */
export const FRAME_SHOWN_TIMEOUT_MS = 15_000;

/** The open still waiting on the page's `frameShown`, and the deadline that puts it down. */
let awaitingFrame: { device: DeviceId; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Stop waiting for `id`'s frame, and only `id`'s. An answer, or a close, for one device never
 * cancels the other's deadline (MICA-475).
 */
const stopWaitingForFrame = (id: DeviceId): void => {
  if (awaitingFrame === null || awaitingFrame.device !== id) return;
  clearTimeout(awaitingFrame.timer);
  awaitingFrame = null;
};

/**
 * Start `id`'s deadline. It replaces any earlier one, so a reopen gets a full window of its
 * own. Missing it closes the device through the every-step close, which releases focus and
 * keep-input whatever else throws.
 */
const waitForFrame = (id: DeviceId): void => {
  if (awaitingFrame !== null) clearTimeout(awaitingFrame.timer);
  const pending = {
    device: id,
    timer: setTimeout(() => {
      if (awaitingFrame !== pending) return;
      awaitingFrame = null;
      console.warn(
        `[mica] the page never drew the ${id} (no frameShown in ${FRAME_SHOWN_TIMEOUT_MS} ms); putting it down to release NUI focus`
      );
      try {
        closeDevice(id);
      } catch (error) {
        // A throw from a timer has nowhere to go. The close ran every step regardless.
        console.error(`[mica] closing the ${id} after its page never drew it:`, error);
      }
    }, FRAME_SHOWN_TIMEOUT_MS)
  };
  awaitingFrame = pending;
};

/**
 * The page's word that it drew `device`'s frame (`frameShown`, MICA-475): the open stops
 * waiting. Honoured only while an open of that device is waiting. A late answer, after the
 * deadline has put the device down, or one naming a device that is not opening, is ignored.
 *
 * Reachable by any script in the page (AGENTS.md §7), so `device` is untrusted. A forged answer
 * can only stop this deadline, which leaves the player's focus where a page that never sends
 * `hideFrame` already leaves it. That is the player's own focus, never a value the server reads.
 */
export const frameShown = (device: unknown): void => {
  if (!isDeviceId(device)) return;
  stopWaitingForFrame(device);
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
    // Until the page answers `frameShown`, focus is held on its word alone (MICA-475).
    waitForFrame(id);

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
  // A device that is down has no frame left to wait for. Left running, the deadline would run
  // this whole close again on a device already down (MICA-475).
  step(() => stopWaitingForFrame(id));
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
