// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, writable, type Readable } from 'svelte/store';
import { callStore } from '../../services/call';
import { ALL_DEVICES, type DeviceId } from '@mica/shared/devices';
import { deadByDevice } from './charge';
import { reducedMotion } from './motion';
import { openDevice } from './phoneOpen';
import { shellReady } from './shellReady';

/**
 * When the phone plays its boot and power-off screens (MICA-236), decided in one place.
 *
 * What the shell already models, and how each maps:
 *
 * - **First open of a session** -> boot. "Session" is the page's life: the CEF page loads
 *   at resource start and lives until disconnect, so a module-scope flag is exactly that.
 *   Closing and reopening the phone afterwards is not a boot -- a real handset that was
 *   only locked does not restart.
 * - **Charge back above zero** (dead true -> false) -> boot, when the phone is
 *   open. If it revived while closed, the *next* open boots, since that is when the player
 *   sees it come back.
 * - **Charge hits zero while the phone is open** -> power-off. It plays over the
 *   dead-battery takeover rather than delaying it, so the takeover stays what `PhoneFrame`
 *   says is true. A phone that is opened already dead shows no animation: the takeover is
 *   the picture, and nothing powered off in front of the player.
 * - **Per device (MICA-337).** Each device has its own battery, so "died" and "revived"
 *   are read off the device that is open, and only from one update to the next on that
 *   same device: switching from a dead phone to a charged tablet is an open, not a
 *   revival, and the tablet dying while the phone is up plays nothing on the phone. A
 *   device that revived while it was not on screen boots on its own next open. The
 *   session's first-open boot stays one per session, whichever device that is.
 * - **Re-enabled after `SetPhoneEnabled`/confiscation** is not a separate case: that is
 *   client-side and simply keeps the frame from opening, so the next open is the ordinary
 *   open above (a boot only if it is the session's first).
 *
 * **How long a boot lasts (MICA-450)** is the phone's readiness, not a timer of its own: it
 * ends once `shellReady` says home has what it needs, but never before `BOOT_MIN_MS` (so the
 * logo never merely flashes) and never after `BOOT_MS` (so a readiness answer that never
 * comes cannot hold the overlay). Ending is a `BOOT_EXIT_MS` fade, `leaving` below, then
 * idle. The power-off screen keeps its fixed `POWER_OFF_MS`: nothing is waited for there.
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
  /** A boot that is fading out (`BOOT_EXIT_MS`), before it goes idle. Absent otherwise. */
  leaving?: true;
}

/** The frame's `transition:fly` in `PhoneFrame.svelte`; boot on open starts after it. */
export const OPEN_FLY_MS = 500;
/**
 * The boot's ceiling, from the overlay's start to its last frame, fade-out included: what a
 * boot lasted before it waited for readiness, so a signal that never arrives costs no more
 * than it always did.
 */
export const BOOT_MS = 1100;
/** The overlay's fade-in. */
export const BOOT_IN_MS = 220;
/**
 * The least a boot shows before it may start leaving, from the overlay's start: the logo's
 * own 400 ms scale-in (`BootScreen.svelte`) and a beat of it still, so it never flashes.
 */
export const BOOT_MIN_MS = 500;
/** The fade-out once a boot ends, early or at the ceiling. */
export const BOOT_EXIT_MS = 250;
export const POWER_OFF_MS = 900;

const IDLE: PowerState = { phase: 'idle', delayMs: 0 };

export const powerState = writable<PowerState>(IDLE);

interface Inputs {
  /** The device whose frame is up, or `null` when none is. */
  device: DeviceId | null;
  dead: Readonly<Record<DeviceId, boolean>>;
  reduced: boolean;
  inCall: boolean;
  /** `shellReady`: home has what it needs, so a boot may end. */
  ready: boolean;
}

/**
 * Start following the shell's state. Returns the stop function. Each call begins a fresh
 * "session", which is how tests get one; `Shell.svelte` calls it once.
 */
export function observePower(): () => void {
  let sessionBooted = false;
  let wasDevice: DeviceId | null = null;
  let wasDead: Partial<Record<DeviceId, boolean>> = {};
  /** Devices that came back from dead while not on screen, so boot on their next open. */
  const bootOnOpen = new Set<DeviceId>();
  let timers: ReturnType<typeof setTimeout>[] = [];
  /** A running boot has shown for `BOOT_MIN_MS`, so readiness alone may now end it. */
  let minShown = false;
  let ready = false;

  const clear = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
    minShown = false;
    if (get(powerState).phase !== 'idle') powerState.set(IDLE);
  };

  const after = (ms: number, fn: () => void) => {
    timers.push(setTimeout(fn, ms));
  };

  const leave = () => {
    const state = get(powerState);
    if (state.phase !== 'boot' || state.leaving) return;
    for (const t of timers) clearTimeout(t);
    timers = [];
    powerState.set({ ...state, leaving: true });
    after(BOOT_EXIT_MS, () => {
      timers = [];
      powerState.set(IDLE);
    });
  };

  const start = (phase: 'boot' | 'off', delayMs: number) => {
    clear();
    powerState.set({ phase, delayMs });
    if (phase === 'off') {
      after(delayMs + POWER_OFF_MS, () => {
        timers = [];
        powerState.set(IDLE);
      });
      return;
    }
    after(delayMs + BOOT_MIN_MS, () => {
      minShown = true;
      if (ready) leave();
    });
    after(delayMs + BOOT_MS - BOOT_EXIT_MS, leave);
  };

  const update = ({ device, dead: deadNow, reduced, inCall, ready: readyNow }: Inputs) => {
    ready = readyNow;
    const opened = device !== null && device !== wasDevice;
    wasDevice = device;
    const revivedOffScreen = ALL_DEVICES.filter(
      (id) => id !== device && wasDead[id] === true && !deadNow[id]
    );
    for (const id of revivedOffScreen) bootOnOpen.add(id);
    const died = device !== null && deadNow[device] && wasDead[device] === false;
    const revived = device !== null && !deadNow[device] && wasDead[device] === true;
    wasDead = { ...deadNow };

    if (device === null) {
      clear();
      return;
    }
    const dead = deadNow[device];

    let phase: 'boot' | 'off' | null = null;
    if (died && !opened) phase = 'off';
    else if (revived) phase = 'boot';
    else if (opened && (!sessionBooted || bootOnOpen.has(device)) && !dead) phase = 'boot';
    if (opened) {
      sessionBooted = true;
      bootOnOpen.delete(device);
    }

    if (reduced || inCall) {
      clear();
      return;
    }
    if (phase) start(phase, opened ? OPEN_FLY_MS : 0);
    else if (ready && minShown) leave();
  };

  const inputs: Readable<Inputs> = derived(
    [openDevice, deadByDevice, reducedMotion, callStore, shellReady],
    ([device, dead, reduced, call, ready]) => ({
      device,
      dead,
      reduced,
      inCall: call.status !== 'idle',
      ready
    })
  );
  const unsubscribe = inputs.subscribe(update);

  return () => {
    unsubscribe();
    clear();
  };
}
