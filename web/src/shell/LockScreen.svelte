<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * The lock screen (MICA-60), scoped exactly as the ticket's own item 4 reads it: a
   * display state, not a security boundary. Nothing rendered here is authority-bearing —
   * the notification preview is the same row `NotificationShade.svelte` would show anyway,
   * and the passcode check is one server round trip that answers yes or no
   * (`services/passcode.ts`). A modified client that skips this component entirely gains
   * nothing it did not already have.
   *
   * Composed from pieces that already exist rather than a data model of its own: the
   * wallpaper is already painted behind this by `PhoneFrame.svelte`'s own `Screen` div, the
   * clock is `state/time.ts`'s existing stores, and the notification list is
   * `services/notifications.ts`'s `shadeNotifications` — the same store `NotificationShade`
   * reads.
   */
  import { formattedTime, formattedDate } from './state/time';
  import { shadeNotifications } from '../services/notifications';
  import { checkPasscodeRemote } from '../services/passcode';
  import { unlock } from './state/lockScreen';
  import { callStore } from '../services/call';
  import { openApp } from './state/navigation';
  import { fade } from '@gphone/sdk';
  import PhoneIcon from '../../../sdk/ui/icons/PhoneIcon.svelte';

  /**
   * `gphone_emergency_number` does not exist as a convar yet — reading one from `web/`
   * needs a client-side NUI action to hand it over (the way `gphone_camera_quality`
   * reaches `cameraQuality` in `client/services/`), and this round is `web/`-only. MICA-64
   * ("a real emergency number concept") is a separate, not-yet-built ticket. Stubbed
   * plainly rather than silently, so it reads as a placeholder rather than a finished
   * feature — Cody's follow-up is a one-line convar read in `client/`, not a UI change.
   */
  const EMERGENCY_NUMBER = '911';

  let digits = $state('');
  let error = $state(false);
  let checking = $state(false);

  const MAX_DIGITS = 6;
  const MIN_DIGITS = 4;

  const recentNotifications = $derived($shadeNotifications.slice(0, 3));

  const pressDigit = (d: string) => {
    if (checking || digits.length >= MAX_DIGITS) return;
    error = false;
    digits += d;
  };

  const backspace = () => {
    if (checking) return;
    error = false;
    digits = digits.slice(0, -1);
  };

  const submit = async () => {
    if (checking || digits.length < MIN_DIGITS) return;
    checking = true;
    try {
      const ok = await checkPasscodeRemote(digits);
      if (ok) {
        unlock();
      } else {
        error = true;
        digits = '';
      }
    } catch {
      // A dead transport is not a wrong guess — leave what was typed rather than blaming
      // the player's memory for a network problem.
      error = true;
    } finally {
      checking = false;
    }
  };

  /**
   * Dial without unlocking. The call is placed exactly the way the Phone app places one
   * (`callStore.startCall`, `services/call.ts`) — the lock screen has no dialer of its own
   * to duplicate that with. Unlocking afterwards is not a bypass of the passcode: it is
   * what showing the in-call screen requires, and nothing about *placing* the call needed
   * the passcode in the first place.
   */
  const handleEmergencyCall = () => {
    callStore.startCall(EMERGENCY_NUMBER);
    unlock();
    openApp('phone');
  };
</script>

<div
  class="bg-scrim absolute inset-0 z-40 flex flex-col items-center backdrop-blur-md"
  role="dialog"
  aria-modal="true"
  aria-label="Lock screen"
>
  <div class="flex flex-col items-center pt-14 pb-4">
    <span class="text-on-surface text-lock-clock font-light">{$formattedTime}</span>
    <span class="text-on-surface-variant text-body-medium mt-2">{$formattedDate}</span>
  </div>

  {#if recentNotifications.length > 0}
    <div class="w-full max-w-[300px] space-y-1.5 px-4">
      {#each recentNotifications as item (item.id)}
        <div
          class="bg-surface-container-high text-on-surface shadow-elevation-2 rounded-box p-2.5 backdrop-blur-md"
        >
          <p class="text-body-small font-bold">{item.title}</p>
          <p class="text-on-surface-variant text-body-small line-clamp-1">{item.body}</p>
        </div>
      {/each}
    </div>
  {/if}

  <div class="flex flex-1 flex-col items-center justify-center gap-6">
    <!-- Progress dots, not the digits themselves — a passcode is not something to render
         as text on a surface anyone standing behind the player can read. -->
    <div class="flex items-center gap-3" aria-live="polite">
      {#each Array(MAX_DIGITS) as _, i (i)}
        <span
          class="h-3 w-3 rounded-full border transition-colors {i < digits.length
            ? error
              ? 'border-error bg-error'
              : 'border-primary bg-primary'
            : 'border-outline-variant bg-transparent'}"
        ></span>
      {/each}
    </div>
    {#if error}
      <p class="text-error text-body-small" transition:fade={{ duration: 150 }}>
        Incorrect passcode
      </p>
    {/if}

    <div class="grid w-full max-w-[260px] grid-cols-3 gap-4">
      {#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as num (num)}
        <button
          type="button"
          class="bg-surface-container hover:bg-surface-container-low duration-short ease-standard flex h-14 w-14 items-center justify-center justify-self-center rounded-full text-xl font-medium transition-colors disabled:opacity-40"
          onclick={() => pressDigit(num.toString())}
          disabled={checking}
        >
          {num}
        </button>
      {/each}
      <div></div>
      <button
        type="button"
        class="bg-surface-container hover:bg-surface-container-low duration-short ease-standard flex h-14 w-14 items-center justify-center justify-self-center rounded-full text-xl font-medium transition-colors disabled:opacity-40"
        onclick={() => pressDigit('0')}
        disabled={checking}
      >
        0
      </button>
      <button
        type="button"
        class="text-on-surface-variant hover:text-on-surface duration-short ease-standard flex h-14 w-14 items-center justify-center justify-self-center rounded-full text-body-small font-medium transition-colors disabled:opacity-40"
        onclick={backspace}
        disabled={checking || digits.length === 0}
        aria-label="Backspace"
      >
        Del
      </button>
    </div>

    <button
      type="button"
      class="bg-primary-container text-on-primary-container shadow-elevation-2 duration-short ease-standard w-full max-w-[260px] rounded-full py-2.5 text-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      onclick={submit}
      disabled={checking || digits.length < MIN_DIGITS}
    >
      {checking ? 'Checking...' : 'Unlock'}
    </button>
  </div>

  <button
    type="button"
    class="text-on-surface-variant hover:text-on-surface duration-short ease-standard mb-12 flex items-center gap-1.5 text-body-medium transition-colors"
    onclick={handleEmergencyCall}
  >
    <PhoneIcon class="size-icon-sm" />
    Emergency Call
  </button>
</div>
