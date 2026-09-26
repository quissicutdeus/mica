<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { OS_NAME } from '@mica/shared/brand';
  import { t } from './messages';
  import { descriptor } from './state/device';
  import { ownerConfig } from './state/ownerConfig';
  import { BOOT_MS, POWER_OFF_MS, powerState } from './state/power';

  /**
   * The boot and power-off screen (MICA-236): the owner's logo, or the micaOS mark, on
   * black, inside the screen box and nowhere else.
   *
   * *When* it plays is `state/power.ts`'s decision and is documented there: the session's
   * first open, coming back from a dead battery, and the battery dying. This is the view.
   *
   * - **Reduced motion:** nothing renders at all. `power.ts` never leaves `idle` under it,
   *   so there is no still frame either; a splash that only blinks is still motion.
   * - **Input:** `pointer-events-none`, always. The overlay ends by unmounting, and until
   *   then a tap falls through to whatever is underneath, so it can never hold a usable
   *   phone hostage. A call cancels it in `power.ts` before it can cover the ring toast.
   * - **Screen box:** mounted by `Shell.svelte` beside the frame and inset by the device's
   *   `bezel`, so it sits exactly on the screen and the player's game shows around it
   *   (AGENTS.md §6). Bottom content is only the logo, centred and lifted by the home
   *   indicator's clearance so it never sits under the gesture bar.
   * - **Logo:** `brandLogo` is an absolute cfx-nui URL. If it fails to load, `onerror`
   *   swaps in the drawn mark rather than leaving a broken-image icon.
   * - **A11y:** `aria-hidden`; a splash announced on every open is noise. The image still
   *   carries an `alt` so it is correct if it is ever read.
   */

  const logo = $derived($ownerConfig.brandLogo ?? null);

  // Which URL failed, not a boolean: a new logo arriving from the server gets its own try.
  let failedLogo = $state<string | null>(null);
  const showImage = $derived(logo !== null && logo !== failedLogo);

  const durationMs = $derived($powerState.phase === 'boot' ? BOOT_MS : POWER_OFF_MS);
</script>

{#if $powerState.phase !== 'idle'}
  <div
    data-testid="boot-screen"
    data-phase={$powerState.phase}
    data-boot="screen"
    aria-hidden="true"
    class="pointer-events-none absolute flex items-center justify-center bg-black {$descriptor.id ===
    'tablet'
      ? 'rounded-frame-inner-tablet'
      : 'rounded-frame-inner'}"
    style="inset: {$descriptor.bezel}px; animation-duration: {durationMs}ms; animation-delay: {$powerState.delayMs}ms;"
  >
    <div data-boot="logo" class="pb-home-indicator flex items-center justify-center">
      {#if showImage && logo}
        <img
          src={logo}
          alt={$t('shell.bootLogoAlt', { brand: OS_NAME })}
          class="max-h-32 max-w-xs object-contain"
          onerror={() => (failedLogo = logo)}
        />
      {:else}
        <!-- The micaOS mark: a phone outline, its camera and its home bar, as `mica.svg`
             draws them, but on the black this screen always is. `mica.svg` itself follows
             the OS colour scheme, which is the wrong thing to follow inside the phone. -->
        <svg
          data-testid="boot-mark"
          viewBox="120 20 272 470"
          class="h-24 w-28"
          role="img"
          aria-label={$t('shell.bootLogoAlt', { brand: OS_NAME })}
        >
          <rect
            x="157"
            y="36"
            width="198"
            height="440"
            rx="32"
            fill="none"
            stroke="#ffffff"
            stroke-width="12"
          />
          <circle cx="256" cy="70" r="8" fill="#ffffff" />
          <path
            d="M236 450h40"
            fill="none"
            stroke="#ffffff"
            stroke-width="6"
            stroke-linecap="round"
          />
        </svg>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Opaque only while it plays; `both` holds the first keyframe (invisible) through the
     delay, so the overlay does not flash black ahead of the frame's fly-in. */
  [data-boot='screen'] {
    animation: boot-run linear both;
  }
  [data-boot='logo'] {
    animation: boot-logo-in 400ms ease-out both;
    animation-delay: inherit;
  }
  @keyframes boot-run {
    0% {
      opacity: 0;
    }
    20% {
      opacity: 1;
    }
    75% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @keyframes boot-logo-in {
    from {
      transform: scale(0.92);
    }
    to {
      transform: scale(1);
    }
  }
</style>
