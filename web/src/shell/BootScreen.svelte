<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { OS_NAME } from '@mica/shared/brand';
  import { t } from './messages';
  import { descriptor } from './state/device';
  import { ownerConfig } from './state/ownerConfig';
  import { BOOT_EXIT_MS, BOOT_IN_MS, POWER_OFF_MS, powerState } from './state/power';

  /**
   * The boot and power-off screen (MICA-236): the owner's logo, or the micaOS mark, on
   * black, inside the screen box and nowhere else.
   *
   * *When* it plays is `state/power.ts`'s decision and is documented there: the session's
   * first open, coming back from a dead battery, and the battery dying. This is the view.
   *
   * - **Two shapes of animation.** Power-off is one fixed run, in and out (`boot-run`). A
   *   boot ends when the phone is ready (MICA-450), which this cannot know in advance, so
   *   it fades in (`boot-in`), holds, and fades out (`boot-out`) only once `power.ts` says
   *   it is `leaving` -- early or at the ceiling, it never cuts.
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

  const durationMs = $derived(
    $powerState.phase === 'off' ? POWER_OFF_MS : $powerState.leaving ? BOOT_EXIT_MS : BOOT_IN_MS
  );
  // The fade-out starts the moment it is asked for: it never waits out the fly-in delay again.
  const delayMs = $derived($powerState.leaving ? 0 : $powerState.delayMs);
</script>

{#if $powerState.phase !== 'idle'}
  <div
    data-testid="boot-screen"
    data-phase={$powerState.phase}
    data-boot="screen"
    data-leaving={$powerState.leaving ? 'true' : undefined}
    aria-hidden="true"
    class="pointer-events-none absolute flex items-center justify-center bg-black {$descriptor.id ===
    'tablet'
      ? 'rounded-frame-inner-tablet'
      : 'rounded-frame-inner'}"
    style="inset: {$descriptor.bezel}px; animation-duration: {durationMs}ms; animation-delay: {delayMs}ms;"
  >
    <div
      data-boot="logo"
      class="pb-home-indicator flex items-center justify-center"
      style="animation-delay: {$powerState.delayMs}ms;"
    >
      {#if showImage && logo}
        <img
          src={logo}
          alt={$t('shell.bootLogoAlt', { brand: OS_NAME })}
          class="max-h-32 max-w-xs object-contain"
          onerror={() => (failedLogo = logo)}
        />
      {:else}
        <!-- The micaOS mark: `web/public/mica.svg` inline, kept in step with it by hand, so
             the boot needs no request and draws offline in CEF. The same markup, shared
             sheet and gradient `href` inheritance included, with two deliberate differences:
             every id is prefixed `mica-boot-`, because an inline SVG's ids are
             document-global and the file's one-letter `f` or `s` could collide with anything
             else in the shell (a dangling `url(#…)` or `href` paints nothing, silently); and
             the file's `<title>` is dropped for the translated `aria-label`.
             The square 50×50 viewBox sits centred in `h-24 w-28` by the default
             `xMidYMid meet`, so it draws 96px tall, about the old outline's height. -->
        <svg
          data-testid="boot-mark"
          viewBox="0 0 50 50"
          class="h-24 w-28"
          role="img"
          aria-label={$t('shell.bootLogoAlt', { brand: OS_NAME })}
        >
          <defs>
            <!-- Blue front, then green and red, the latter two inheriting the front's axis. -->
            <linearGradient
              id="mica-boot-f"
              x1="14"
              x2="38"
              y1="8"
              y2="56"
              gradientUnits="userSpaceOnUse"
            >
              <stop stop-color="#3b82f6" />
              <stop offset=".5" stop-color="#155dfc" />
              <stop offset="1" stop-color="#1e40af" />
            </linearGradient>
            <linearGradient id="mica-boot-m" href="#mica-boot-f">
              <stop stop-color="#22c55e" />
              <stop offset="1" stop-color="#15803d" />
            </linearGradient>
            <linearGradient id="mica-boot-b" href="#mica-boot-f">
              <stop stop-color="#ef4444" />
              <stop offset="1" stop-color="#b91c1c" />
            </linearGradient>
            <!-- One sheet, drawn three times and clipping the sheen. -->
            <rect id="mica-boot-s" width="24" height="48" x="14" y="8" rx="6" />
            <clipPath id="mica-boot-c"><use href="#mica-boot-s" /></clipPath>
          </defs>
          <g transform="matrix(.98 0 0 .98 -5.88 -6.86)">
            <use href="#mica-boot-s" fill="url(#mica-boot-b)" transform="rotate(16 26 56)" />
            <use href="#mica-boot-s" fill="url(#mica-boot-m)" transform="rotate(8 26 56)" />
            <use href="#mica-boot-s" fill="url(#mica-boot-f)" />
            <path
              fill="#fff"
              fill-opacity=".14"
              d="M14 8h24v12L14 34z"
              clip-path="url(#mica-boot-c)"
            />
            <circle cx="26" cy="13.5" r="1.6" fill="#fff" />
            <path stroke="#fff" stroke-linecap="round" stroke-width="2.2" d="M21.5 50.5h9" />
          </g>
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
  [data-boot='screen'][data-phase='boot'] {
    animation-name: boot-in;
    animation-timing-function: ease-out;
  }
  /* From fully in: `power.ts` never leaves before `BOOT_MIN_MS`, which outlasts `BOOT_IN_MS`. */
  [data-boot='screen'][data-leaving] {
    animation-name: boot-out;
    animation-timing-function: ease-in;
  }
  /* Its delay is the open's, set on the element itself rather than inherited, so the
     screen's delay dropping to zero for the fade-out cannot retime it. */
  [data-boot='logo'] {
    animation: boot-logo-in 400ms ease-out both;
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
  @keyframes boot-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes boot-out {
    from {
      opacity: 1;
    }
    to {
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
