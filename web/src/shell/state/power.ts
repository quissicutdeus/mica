// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, writable, type Readable } from 'svelte/store';
import { callStore } from '../../services/call';
import { isBatteryDead } from './charge';
import { reducedMotion } from './motion';
import { isPhoneOpen } from './phoneOpen';

/**
 * When the phone plays its boot and power-off screens (MICA-236), decided in one place.
 *
 * What the shell already models, and how each maps:
 *
 * - **First open of a session** -> boot. "Session" is the page's life: the CEF page loads
 *   at resource start and lives until disconnect, so a module-scope flag is exactly that.
 *   Closing and reopening the phone afterwards is not a boot -- a real handset that was
 *   only locked does not restart.
 * - **Charge back above zero** (`isBatteryDead` true -> false) -> boot, when the phone is
 *   open. If it revived while closed, the *next* open boots, since that is when the player
 *   sees it come back.
 * - **Charge hits zero while the phone is open** -> power-off. It plays over the
 *   dead-battery takeover rather than delaying it, so the takeover stays what `PhoneFrame`
 *   says is true. A phone that is opened already dead shows no animation: the takeover is
 *   the picture, and nothing powered off in front of the player.
 * - **Re-enabled after `SetPhoneEnabled`/confiscation** is not a separate case: that is
 *   client-side and simply keeps the frame from opening, so the next open is the ordinary
 *   open above (a boot only if it is the session's first).
 *
 * What suppresses it: reduced motion (nothing plays at all -- a logo that merely blinks in
 * and out is still motion, and the player asked for none), and any call that is not idle
 * (a ringing phone shows the ring toast, never a splash over it). Closing the phone
 * cancels it. The overlay never takes input (`BootScreen.svelte`), so it cannot block a
 * phone that is already usable.
 */
export type PowerPhase = 'idle' | 'boot' | 'off';

export interface PowerState {
  phase: PowerPhase;
  /** How long the overlay waits before it appears, so it can follow the frame's fly-in. */
  delayMs: number;
}

/** The frame's `transition:fly` in `PhoneFrame.svelte`; boot on open starts after it. */
export const OPEN_FLY_MS = 500;
export const BOOT_MS = 1100;
export const POWER_OFF_MS = 900;

const IDLE: PowerState = { phase: 'idle', delayMs: 0 };

export const powerState = writable<PowerState>(IDLE);

interface Inputs {
  open: boolean;
  dead: boolean;
  reduced: boolean;
  inCall: boolean;
}

/**
 * Start following the shell's state. Returns the stop function. Each call begins a fresh
 * "session", which is how tests get one; `Shell.svelte` calls it once.
 */
export function observePower(): () => void {
  let sessionBooted = false;
  let wasOpen = false;
  let wasDead = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (get(powerState).phase !== 'idle') powerState.set(IDLE);
  };

  const start = (phase: 'boot' | 'off', delayMs: number) => {
    clear();
    powerState.set({ phase, delayMs });
    timer = setTimeout(
      () => {
        timer = undefined;
        powerState.set(IDLE);
      },
      delayMs + (phase === 'boot' ? BOOT_MS : POWER_OFF_MS)
    );
  };

  const update = ({ open, dead, reduced, inCall }: Inputs) => {
    const opened = open && !wasOpen;
    const died = dead && !wasDead;
    const revived = !dead && wasDead;
    wasOpen = open;
    wasDead = dead;

    if (!open) {
      clear();
      if (revived) sessionBooted = false;
      return;
    }

    let phase: 'boot' | 'off' | null = null;
    if (died && !opened) phase = 'off';
    else if (revived) phase = 'boot';
    else if (opened && !sessionBooted && !dead) phase = 'boot';
    if (opened) sessionBooted = true;

    if (reduced || inCall) {
      clear();
      return;
    }
    if (phase) start(phase, opened ? OPEN_FLY_MS : 0);
  };

  const inputs: Readable<Inputs> = derived(
    [isPhoneOpen, isBatteryDead, reducedMotion, callStore],
    ([open, dead, reduced, call]) => ({ open, dead, reduced, inCall: call.status !== 'idle' })
  );
  const unsubscribe = inputs.subscribe(update);

  return () => {
    unsubscribe();
    clear();
  };
}
