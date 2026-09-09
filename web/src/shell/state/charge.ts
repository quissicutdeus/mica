// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, writable } from 'svelte/store';
import { isBrowser } from '@mica/sdk';

// Charge level between 0 and 100
export const charge = writable<number>(100);

// Rounded to nearest hundredth (2 decimal places)
export const roundedCharge = derived(charge, ($charge) => {
  return Math.round(Math.max(0, Math.min(100, $charge)) * 100) / 100;
});

// Display percentage using Math.ceil so non-zero values (like 0.49) display as 1% instead of 0%
export const displayCharge = derived(roundedCharge, ($roundedCharge) => {
  if ($roundedCharge <= 0) return 0;
  return Math.ceil($roundedCharge);
});

// Flag indicating if the battery is completely drained
export const isBatteryDead = derived(roundedCharge, ($roundedCharge) => {
  return $roundedCharge <= 0;
});

// Simulate battery deterioration in browser dev mode (outside FiveM NUI)
if (isBrowser()) {
  let lastTime = Date.now();
  let drainMultiplier = 1.0; // Standard 1x speed (1% per minute)

  setInterval(() => {
    const now = Date.now();
    const deltaSeconds = (now - lastTime) / 1000;
    lastTime = now;

    const drainPerSecond = (1.0 / 60) * drainMultiplier;
    charge.update(($charge) => Math.max(0, $charge - drainPerSecond * deltaSeconds));
  }, 1000);

  // Browser dev helpers available in browser console (F12):
  // - setBattery(50)       -> Set battery level to 50%
  // - setDrainSpeed(10)    -> Speed up battery drain by 10x for testing
  window.setBattery = (val: number) => {
    lastTime = Date.now();
    charge.set(val);
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
 * The armed/fired flags, global so that a warning fires once per drain cycle however many
 * frames mount and unmount around it — the phone opening and closing must never re-warn.
 * `BatteryWarning.svelte` is the only writer in the shell; tests reset it directly.
 */
export const firedBatteryWarnings = writable<FiredBatteryWarnings>(NO_BATTERY_WARNINGS_FIRED);

/**
 * One tick of the arming logic, pure so the cases can be tested without a component.
 *
 * - A threshold the level is **above** re-arms. That is the only charging signal the web
 *   side has: the client's charging flag was removed when the drain moved server-side
 *   (`client/services/Battery.ts`), so "charging" here means the level came back up.
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
