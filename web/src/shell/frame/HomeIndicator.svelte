<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { goHome } from '../state/navigation';
  import { shadeDragRevealDistance } from '../state/display';
  import { isShadeOpen, closeShade } from '../state/shade';
  import { closeDrawer, isDrawerOpen } from '../state/appDrawer';
  import { attachHomeBarDrag } from './frameGestures';

  /**
   * The home indicator gesture bar, out of `PhoneFrame.svelte` so the tablet's frame draws
   * the same one (MICA-259).
   *
   * The label names the one action the press will actually perform, rather than
   * listing both. It briefly read "Return to home screen or collapse notifications",
   * which is worse on both counts: a screen reader hears a disjunction it has to
   * resolve itself, and four e2e specs match this attribute exactly and silently
   * stopped finding the button. Same shape as the status bar.
   *
   * `h-6` centered gives the pill even clearance from the screen edge below and
   * whatever sits above it — originally `Dock` once it moved off the `bottom-6` that
   * crowded this bar, and now `Search.svelte`'s collapsed bar at `bottom-8`, with the
   * Dock pushed up to `bottom-20` behind it.
   *
   * `z-60`, the same layer the status bar uses and for the same reason: the shade and
   * drawer sheets are `absolute inset-0 z-55`, so at `z-50` this button was painted over
   * whenever either was open and could not be pressed at all. It was still there, still
   * labelled "Collapse notifications", and entirely unclickable — which is what made the
   * shade spec hang: Playwright correctly refused to click a covered element and waited
   * out the full timeout. The shade used to paper over that with a grab handle of its
   * own, sitting on top of this one and doing the same job; that handle is gone
   * (MICA-36) now that a swipe closes the shade, so this is the affordance again and
   * it has to be reachable.
   */

  let homeBarRef = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!homeBarRef) return;
    return attachHomeBarDrag(homeBarRef, $shadeDragRevealDistance);
  });
</script>

<button
  bind:this={homeBarRef}
  class="h-home-indicator absolute bottom-0 left-0 z-60 flex w-full cursor-pointer items-center justify-center"
  onclick={() => {
    if ($isShadeOpen) {
      closeShade();
    } else if ($isDrawerOpen) {
      // MICA-45: this button used to not check the drawer, so it fell through to
      // the no-op goHome() branch and left the drawer open.
      closeDrawer();
    } else {
      goHome();
    }
  }}
  aria-label={$isShadeOpen
    ? 'Collapse notifications'
    : $isDrawerOpen
      ? 'Close app drawer'
      : 'Return to home screen'}
>
  <!-- White over an app, but the sheets it now sits above are
       `bg-surface-container-high` — near-white in the light scheme, where a white pill
       is invisible. The `on-surface` roles invert with the scheme, so they read in both.
       `on-surface-variant` rather than `on-surface/80`: §6 forbids an opacity modifier
       on a themed role token, because those are written as inline custom properties at
       runtime and `app-utilities.css` generates no class for the modified form — the
       pill would simply render with no background. The variant role is the
       pre-resolved, dimmer counterpart and needs no modifier. -->
  <div
    class="duration-medium ease-emphasized h-1 w-1/3 rounded-full transition-colors {$isShadeOpen ||
    $isDrawerOpen
      ? 'bg-on-surface-variant hover:bg-on-surface'
      : 'bg-white/80 hover:bg-white'}"
  ></div>
</button>
