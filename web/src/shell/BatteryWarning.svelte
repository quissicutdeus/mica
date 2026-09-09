<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { t } from './messages';
  import { toast } from './state/toast';
  import {
    displayCharge,
    isBatteryDead,
    firedBatteryWarnings,
    stepBatteryWarning
  } from './state/charge';
  import { isLocked } from './state/lockScreen';
  import { callStore } from '../services/call';

  /**
   * Warn a player before the battery dies (MICA-193). Renders nothing; it is mounted
   * inside `PhoneFrame.svelte` and `TabletFrame.svelte` purely for its effect.
   *
   * Decisions, and why:
   *
   * - **A toast, not a modal.** `toast.show` already exists, interrupts less, and leaves a
   *   row in the shade for a player who looked away. A full-frame takeover is what the
   *   dead battery gets; a warning that the phone still works does not earn one.
   * - **20% and 5%**, read from `displayCharge` — the store and the comparison the status
   *   bar uses to turn the percentage red, so the toast and the bar never disagree.
   * - **Once per drain cycle per threshold.** The fired flags live in
   *   `state/charge.ts` (`firedBatteryWarnings`), not here: a frame mounts on every phone
   *   open, and component state would re-warn each time. Rising back above a threshold
   *   re-arms it; that is the only charging signal the web side has, since the client's
   *   charging flag went with the server-side drain (`client/services/Battery.ts`).
   * - **Held, not dropped, while blocked.** Dead (`isBatteryDead`), in a call
   *   (`callStore.status !== 'idle'` — dialing and ringing count, a toast over a call
   *   banner is the worst moment) or on the lock screen (`isLocked`, so the toast can
   *   never sit over a screen with no way to dismiss it). A blocked threshold stays armed
   *   and fires on the first tick that is clear, so ending a call at 12% still warns.
   * - **The tablet gets it too.** There is one `charge` store until MICA-264, so the
   *   tablet's battery is the phone's; `isLocked` and the call store are simply never set
   *   on a tablet (`shared/devices.ts` gives it neither).
   * - **`source: 'system'`**, which `notificationPolicy.ts` never suppresses — Do Not
   *   Disturb muting the one warning that the phone is about to stop working would be
   *   the policy defeating its own purpose. Lower than a call's 12s, longer than the
   *   4.5s default: long enough to read from across the room.
   */

  const WARNING_DURATION_MS = 6000;

  $effect(() => {
    const level = $displayCharge;
    const blocked = $isBatteryDead || $isLocked || $callStore.status !== 'idle';
    const before = $firedBatteryWarnings;
    const { fired, due } = stepBatteryWarning(before, level, blocked);
    // Write only on a real change: the effect reads the store it writes, and an
    // unconditional set of a fresh object would re-run it forever.
    if (fired[20] !== before[20] || fired[5] !== before[5]) firedBatteryWarnings.set(fired);
    if (due === null) return;
    toast.show({
      app: 'system',
      source: 'system',
      type: 'warning',
      title: $t('shell.batteryLow'),
      message: $t('shell.batteryLowMessage', { percent: level }),
      duration: WARNING_DURATION_MS
    });
  });
</script>
