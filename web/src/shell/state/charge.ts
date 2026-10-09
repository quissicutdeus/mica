// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, writable, type Readable, type Writable } from 'svelte/store';
import { isBrowser } from '@mica/sdk';
import { ALL_DEVICES, type DeviceId } from '@mica/shared/devices';
import { activeDevice } from './device';

/**
 * Each device's battery (MICA-337): the tablet has a charge of its own, drained and charged
 * independently of the phone's, and a dead one never blocks the other.
 *
 * Every derivation is kept once per device (`chargeOf`, `displayChargeOf`,
 * `isBatteryDeadOf`), and the unsuffixed stores below them follow `activeDevice`. That
 * split decides who reads which:
 *
 * - **A frame reads its own device by name.** `PhoneFrame` reads the phone's dead state and
 *   `TabletFrame` the tablet's, so neither can blank because of the other.
 * - **Whatever means "the device in front of the player"** — the status bar, the volume keys,
 *   the `systemHardware` facet an app reads its battery from — reads the unsuffixed stores,
 *   which is the active device's. Only one frame is up at a time, and it is always the
 *   active one (`Shell.svelte`), so the two agree on screen.
 */
type PerDevice<T> = Readonly<Record<DeviceId, T>>;

const perDevice = <T>(build: (id: DeviceId) => T): PerDevice<T> =>
  Object.fromEntries(ALL_DEVICES.map((id) => [id, build(id)])) as Record<DeviceId, T>;

/** Each device's charge level, between 0 and 100. */
export const chargeOf: PerDevice<Writable<number>> = perDevice(() => writable<number>(100));

// Rounded to nearest hundredth (2 decimal places)
const round = (level: number): number => Math.round(Math.max(0, Math.min(100, level)) * 100) / 100;

const roundedChargeOf: PerDevice<Readable<number>> = perDevice((id) =>
  derived(chargeOf[id], round)
);

// Display percentage using Math.ceil so non-zero values (like 0.49) display as 1% instead of 0%
export const displayChargeOf: PerDevice<Readable<number>> = perDevice((id) =>
  derived(roundedChargeOf[id], ($rounded) => ($rounded <= 0 ? 0 : Math.ceil($rounded)))
);

/** Whether the named device's battery is completely drained. */
export const isBatteryDeadOf: PerDevice<Readable<boolean>> = perDevice((id) =>
  derived(roundedChargeOf[id], ($rounded) => $rounded <= 0)
);

/** Every device's dead flag at once, for a reader that picks the device itself. */
export const deadByDevice: Readable<PerDevice<boolean>> = derived(
  ALL_DEVICES.map((id) => isBatteryDeadOf[id]),
  ($dead) => perDevice((id) => $dead[ALL_DEVICES.indexOf(id)])
);

/**
 * Whether each device is on a charger, as the client forwards the server's
 * `mica:client:battery:charging` (MICA-337). Kept per device so a tablet on charge never
 * reads as a phone on charge; nothing in the shell paints it yet, and the low-battery
 * warnings still re-arm on the level rising (`stepBatteryWarning`), not on this flag.
 */
export const chargingOf: PerDevice<Writable<boolean>> = perDevice(() => writable(false));

/** Pick the active device's store out of a per-device table. */
const followActive = <T>(table: PerDevice<Readable<T>>): Readable<T> =>
  derived(
    [activeDevice, ...ALL_DEVICES.map((id) => table[id])],
    ([$id, ...$values]) => $values[ALL_DEVICES.indexOf($id)]
  );

/**
 * The active device's charge. A write lands on the active device's own store: it is what the
 * `systemHardwareWrite` facet's `setCharge` means, and Developer Tools runs on the device it
 * is open on.
 */
export const charge: Writable<number> = {
  subscribe: followActive(chargeOf).subscribe,
  set: (level) => chargeOf[get(activeDevice)].set(level),
  update: (fn) => chargeOf[get(activeDevice)].update(fn)
};

export const roundedCharge = followActive(roundedChargeOf);
export const displayCharge = followActive(displayChargeOf);
/** Whether the active device's battery is completely drained. */
export const isBatteryDead = followActive(isBatteryDeadOf);

// Simulate battery deterioration in browser dev mode (outside FiveM NUI). Each device drains
// on its own, as the server drains each one in game (MICA-337).
if (isBrowser()) {
  let lastTime = Date.now();
  let drainMultiplier = 1.0; // Standard 1x speed (1% per minute)

  setInterval(() => {
    const now = Date.now();
    const deltaSeconds = (now - lastTime) / 1000;
    lastTime = now;

    const drainPerSecond = (1.0 / 60) * drainMultiplier;
    for (const id of ALL_DEVICES) {
      chargeOf[id].update(($charge) => Math.max(0, $charge - drainPerSecond * deltaSeconds));
    }
  }, 1000);

  // Browser dev helpers available in browser console (F12):
  // - setBattery(50)           -> Set the active device's battery to 50%
  // - setBattery(5, 'tablet')  -> Set the tablet's battery to 5%, whichever is on screen
  // - setDrainSpeed(10)        -> Speed up battery drain by 10x for testing
  window.setBattery = (val: number, device?: DeviceId) => {
    lastTime = Date.now();
    chargeOf[device ?? get(activeDevice)].set(val);
  };
  window.setDrainSpeed = (multiplier: number) => {
    drainMultiplier = multiplier;
  };
}

/**
 * Low-battery warning thresholds (MICA-193), highest first. They agree with what the
 * status bar paints: `StatusBar.svelte` turns the percentage `text-error` at
 * `displayCharge <= 20`, so the same store and the same comparison decide the toast.
 */
export const BATTERY_WARNING_THRESHOLDS = [20, 5] as const;
export type BatteryWarningThreshold = (typeof BATTERY_WARNING_THRESHOLDS)[number];

/** Which thresholds have already been warned for in the current drain cycle. */
export type FiredBatteryWarnings = Readonly<Record<BatteryWarningThreshold, boolean>>;

export const NO_BATTERY_WARNINGS_FIRED: FiredBatteryWarnings = { 20: false, 5: false };

/**
 * The armed/fired flags, one set per device (MICA-337), each global so that a warning fires
 * once per drain cycle however many frames mount and unmount around it — the phone opening
 * and closing must never re-warn, and the tablet draining must neither re-warn nor silence
 * the phone. `BatteryWarning.svelte` is the only writer in the shell; tests reset them
 * directly.
 */
export const firedBatteryWarningsOf: PerDevice<Writable<FiredBatteryWarnings>> = perDevice(() =>
  writable<FiredBatteryWarnings>(NO_BATTERY_WARNINGS_FIRED)
);

/**
 * One tick of the arming logic, pure so the cases can be tested without a component.
 *
 * - A threshold the level is **above** re-arms: "charging" here means the level came back
 *   up, not `chargingOf`, since a warning is about how much charge is left.
 * - A threshold the level is **at or below**, still armed, is due — unless `blocked`
 *   (dead, in a call, or on the lock screen), in which case it stays armed and fires on
 *   the first unblocked tick. A dead phone re-arms nothing either: level 0 is below both.
 * - When several thresholds come due at once (100% → 4% in one push) only the lowest is
 *   reported and all of them are marked fired: one toast, not a stack of them.
 */
export function stepBatteryWarning(
  fired: FiredBatteryWarnings,
  level: number,
  blocked: boolean
): { fired: FiredBatteryWarnings; due: BatteryWarningThreshold | null } {
  const next: Record<BatteryWarningThreshold, boolean> = { ...fired };
  let due: BatteryWarningThreshold | null = null;
  for (const threshold of BATTERY_WARNING_THRESHOLDS) {
    if (level > threshold) {
      next[threshold] = false;
    } else if (!fired[threshold] && !blocked) {
      next[threshold] = true;
      due = threshold;
    }
  }
  return { fired: next, due };
}
