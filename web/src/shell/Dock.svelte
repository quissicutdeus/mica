<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { t } from './messages';
  import { anySheetOpen } from './state/sheets';
  import { badgeAllowed } from './state/notificationPolicy';
  import { get } from 'svelte/store';
  import { attachDragGesture } from '../lib/phone/pointerDrag';
  import { createSheetOpen, DRAWER_OPEN_COMMIT } from '../lib/phone/sheetDrag';
  import AppIcon from '../../../sdk/ui/AppIcon.svelte';
  import { appRegistryStore } from './state/registry';
  import { appVisible } from './state/appVisibility';
  import { dockAppIds, dockSlotCount } from './state/dock';
  import {
    openDrawer,
    isDrawerOpen,
    drawerDragProgress,
    drawerDragPhase,
    closeDrawer
  } from './state/appDrawer';
  import { shadeDragRevealDistance } from './state/display';
  import { appDrawerHintSeen } from './state/onboarding';

  let { openApp } = $props<{ openApp: (id: string) => void }>();

  let dockElement = $state<HTMLElement | null>(null);

  /**
   * The dock applied no visibility filter at all — not `requiresAdmin`, and so not the
   * `requires` capability check either. An app the launcher, the drawer, the folders and
   * search all agreed to hide still drew its icon here and still opened from it, which is
   * the only surface that could have said so out loud. Pinning is a placement, not an
   * exemption: a slot whose app is not visible falls back to the same empty placeholder an
   * unconfigured or unresolvable slot already gets, so the dock never collapses to fewer
   * than `dockSlotCount` cells and the player's own pin survives in `dockAppIds` for
   * whenever the app is honourable again.
   */
  const slots = $derived(
    Array.from({ length: $dockSlotCount }, (_, index) => {
      const appId = $dockAppIds[index] ?? '';
      const resolved = appId ? appRegistryStore.getManifest(appId) : undefined;
      const manifest = $appVisible(resolved) ? resolved : undefined;
      return { index, appId, manifest };
    })
  );

  /** A plain tap opens an app; a swipe anywhere on the dock pulls the drawer up. */
  const openDrag = createSheetOpen({
    direction: 'up',
    progress: drawerDragProgress,
    phase: drawerDragPhase,
    revealDistance: $shadeDragRevealDistance,
    guard: () => !anySheetOpen(),
    open: openDrawer,
    commit: DRAWER_OPEN_COMMIT
  });

  $effect(() => {
    if (!dockElement) return;
    return attachDragGesture(dockElement, {
      axis: 'y',
      onMove: openDrag.onMove,
      onEnd: openDrag.onEnd,
      onCancel: openDrag.abandon
    });
  });
</script>

<!-- Fixed dock — 4 slots on the phone, 6 on the tablet (`shared/devices.ts`) — always at
     the bottom of the home screen, above the frame's
     own home-indicator gesture bar and the collapsed home-screen search bar.

     `bottom-20`. It was `bottom-10`, itself raised from a `bottom-6` that shared the
     gesture bar's own height token — the two were sized off the same number
     coincidentally, not because a dock label's true bottom edge and the gesture bar's
     clear band actually lined up, and at `bottom-6` the label crowded the bar with only a
     few px between them. The further 40px came from `Search.svelte`'s collapsed bar
     claiming the band at `bottom-8`; the first-run hint below moved by that same 40px
     (`bottom-32` to `bottom-44`) so the gap between hint and icons — the thing the
     overlap regression in `e2e/defects.spec.ts` actually guards — is unchanged.

     Never collapses to fewer than 4 cells — an unconfigured
     or unresolvable slot renders an empty placeholder rather than shrinking the row,
     since the dock's whole value is that a slot is always in the same place.

     No card background — a dock slot is a home-grid icon that happens to be pinned, not
     a visually distinct control, so it should look identical to one instead of sitting
     inside its own surface/shadow/rounded-chip pill. `pt-4` (not `pt-2`) is deliberate too:
     the swipe-up-to-open-the-drawer gesture is attached to this whole element, and at
     `py-2` its hit area barely cleared the icons themselves — a drag starting just above
     the icon glyph had nothing to grab. The extra padding is graspable margin, not a
     layout change the icons themselves need.

     `pb-0` rather than matching that same generous padding below: back when the dock sat
     at `bottom-10`, `pb-4` put the icon block's own top edge at 140px from the screen
     bottom, inside the first-run "Swipe up for apps" hint's box (then `bottom-32`, 128px
     to 144px) — the hint was drawn
     directly over the icons on every fresh install, not just over blank padding above
     them (MICA hint/dock overlap defect). Dropping the bottom padding pulls the icon
     block down by the same 16px without touching the hint or the dock's own `bottom-10`
     anchor (already tuned against the gesture bar below, see above): grab room below an
     icon is still there, it is just the dock's own bottom edge now rather than a padded
     margin inside it.

     `px-4` and a 4-column CSS grid, not `px-6` and `flex justify-around` — that mismatch
     used to put the dock's own slot centers a few px off from the home grid's column
     centers directly above them, which read as sloppy the moment an app sat in the
     bottom row of the grid on top of a dock slot. Matching `Launcher.svelte`'s own
     padding and grid mechanics (rather than flexbox's different distribution math) is
     what makes slot 0 land under column 0 exactly — true whenever the home grid itself
     is at its default 4 columns; the dock is always 4 slots, so a grid resized to 3 or 5
     columns necessarily drifts, the same way it would against any other fixed-width
     neighbor.

     `cursor-pointer` on the whole element, matching the status bar's own pull-down
     handle (`PhoneFrame.svelte`): the swipe-up gesture is attached here, not to a
     `<button>`, so without it the cursor gave no hint this whole band was grabbable. -->
<div
  bind:this={dockElement}
  role="toolbar"
  aria-label={$t('shell.dock')}
  class="absolute inset-x-0 bottom-20 z-20 grid cursor-pointer px-4 pt-4 pb-0 select-none"
  style="grid-template-columns: repeat({$dockSlotCount}, 1fr);"
>
  {#each slots as slot (slot.index)}
    <div data-dock-index={slot.index} class="flex items-center justify-center">
      {#if slot.manifest}
        <AppIcon
          name={slot.manifest.name}
          badgeSuppressed={!$badgeAllowed(slot.appId)}
          color={slot.manifest.color}
          icon={slot.manifest.icon}
          badgeStore={slot.manifest.badgeStore}
          onclick={() => {
            if (get(isDrawerOpen)) closeDrawer();
            openApp(slot.appId);
          }}
        />
      {:else}
        <div class="border-outline-variant h-14 w-14 rounded-box border border-dashed"></div>
      {/if}
    </div>
  {/each}
</div>

{#if !$appDrawerHintSeen}
  <!-- Fresh home grid ships empty by default (apps live in the drawer until dragged
       out), which otherwise leaves a first-time player looking at wallpaper and a dock
       with nothing telling them to swipe up. Gone for good the moment the drawer opens
       once — `openDrawer` marks it seen — so this only ever shows on a truly first run;
       `pointer-events-none` keeps it from stealing the dock's own swipe-up gesture. -->
  <p
    class="text-on-surface-variant text-label-small pointer-events-none absolute inset-x-0 bottom-44 z-20 text-center select-none"
  >
    {$t('shell.swipeUpForApps')}
  </p>
{/if}
