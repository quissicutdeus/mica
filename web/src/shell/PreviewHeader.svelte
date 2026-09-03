<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { ALL_DEVICES, DEVICES, type DeviceId } from '@gphone/shared/devices';
  import { OS_NAME } from '@gphone/shared/brand';
  import { t } from './messages';
  import { activeDevice } from './state/device';

  /**
   * The browser preview's own chrome: a gOS mark and one link per device.
   *
   * **Outside the device, and browser-only.** `Shell.svelte` renders this behind
   * `isBrowser()`, so it exists in `pnpm dev` and `vite preview` and never in CEF, where
   * anything painted outside the frame is painted over the player's game. That is the
   * whole reason it is a separate component rather than a band inside `PhoneFrame`.
   *
   * **Links, not buttons, and both halves matter.** The `href` is real, so a demo can be
   * copied out of the address bar, opened in a new tab, or middle-clicked — which is what
   * makes these useful to hand to somebody. The click is then intercepted and answered by
   * `setActiveDevice` in place, so switching costs no reload and the phone keeps whatever
   * app it was left on. `history.replaceState` catches the address bar up afterwards.
   *
   * Being anchors rather than buttons is also what keeps them out of the suite's way:
   * `e2e/apps/phone.spec.ts` opens the Phone app with `locator('button', { hasText:
   * 'Phone' }).first()`, and an `<a>` carries role `link`, so a header entry labelled
   * "Phone" cannot be mistaken for the app icon.
   *
   * The list is `ALL_DEVICES`, not two hardcoded entries: a third device in
   * `shared/devices.ts` appears here with no edit, the same way it does in the keybind
   * dispatch and the frame switch.
   */

  let { onopen }: { onopen: (device: DeviceId) => void } = $props();

  /**
   * The phone is the default device, so it is the bare path — `?device=phone` would work
   * too, but the phone's link is the one people paste, and it should be the clean one.
   * Relative, so a preview served under a sub-path still resolves.
   */
  const hrefFor = (device: DeviceId): string => (device === 'phone' ? './' : `./?device=${device}`);

  const open = (event: MouseEvent, device: DeviceId) => {
    // Let the browser have the ones that mean "somewhere else": a new tab, a new window,
    // a download. Only a plain left click is ours to answer in place.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    event.preventDefault();
    onopen(device);
    window.history.replaceState(null, '', hrefFor(device));
  };
</script>

<!-- `pointer-events-none` on the wrapper and `auto` on the bar itself: on a window short
     enough that the device reaches the top of the page, the header overlaps it, and a
     transparent wrapper that swallowed clicks would make the top of the screen dead.
     Only the bar is clickable; everything either side of it passes straight through.

     Top-left rather than centred, for the same reason — the device is centred, so a bar
     in the corner is the position least likely to sit over it. `z-[9998]` puts it under
     the reopen pill at `z-[9999]`, which is the one thing that should always win. -->
<div class="pointer-events-none fixed inset-x-0 top-0 z-[9998] flex p-3">
  <nav
    aria-label={$t('shell.previewNav', { os: OS_NAME })}
    class="bg-surface-container shadow-elevation-3 pointer-events-auto flex items-center gap-1 rounded-box p-1.5 backdrop-blur-md"
  >
    <!-- The mark. A rounded tile with the family letter, the same shape an app icon
         takes, so it reads as this product rather than as browser furniture. Deliberately
         not an `<h1>`: the launcher's wordmark is the page's heading, and two specs assert
         there is no `h1` on the page once the device is down. -->
    <span class="flex items-center gap-2 px-2">
      <span
        class="bg-primary text-on-primary text-label-small flex h-6 w-6 items-center justify-center rounded-chip font-bold"
        aria-hidden="true">g</span
      >
      <span class="text-on-surface text-body-small font-semibold tracking-tight">{OS_NAME}</span>
    </span>

    {#each ALL_DEVICES as id (id)}
      {@const current = $activeDevice === id}
      <a
        href={hrefFor(id)}
        onclick={(event) => open(event, id)}
        aria-current={current ? 'page' : undefined}
        class="text-body-small duration-short ease-standard rounded-chip px-3 py-1.5 font-medium no-underline transition-colors {current
          ? 'bg-primary-container text-on-primary-container'
          : 'text-on-surface-variant hover:bg-surface-container-high'}"
      >
        {DEVICES[id].label}
      </a>
    {/each}
  </nav>
</div>
