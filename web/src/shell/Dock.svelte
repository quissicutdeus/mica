<script lang="ts">
  import { get } from 'svelte/store';
  import { attachDragGesture, clampProgress, shouldCommitDrag } from '../lib/pointerDrag';
  import AppIcon from '../sdk/ui/AppIcon.svelte';
  import { appRegistryStore } from './state/registry';
  import { dockAppIds, DOCK_SLOT_COUNT } from './state/dock';
  import {
    openDrawer,
    isDrawerOpen,
    drawerDragProgress,
    drawerDragPhase,
    closeDrawer
  } from './state/appDrawer';
  import { SHADE_DRAG_REVEAL_DISTANCE } from './state/display';
  import { appDrawerHintSeen } from './state/onboarding';

  let { openApp } = $props<{ openApp: (id: string) => void }>();

  let dockElement = $state<HTMLElement | null>(null);

  const slots = $derived(
    Array.from({ length: DOCK_SLOT_COUNT }, (_, index) => {
      const appId = $dockAppIds[index] ?? '';
      const manifest = appId ? appRegistryStore.getManifest(appId) : undefined;
      return { index, appId, manifest };
    })
  );

  /**
   * A plain tap opens an app (`attachDragGesture` never commits until the pointer moves
   * past `axisThreshold`), and a swipe starting anywhere on the dock — including on top
   * of an icon — pulls the drawer up. This mirrors the status bar's pull-down-the-shade
   * gesture in `PhoneFrame.svelte`, inverted: negative deltaY is "up".
   */
  $effect(() => {
    if (!dockElement) return;
    return attachDragGesture(dockElement, {
      axis: 'y',
      onMove: (deltaY) => {
        if (get(isDrawerOpen)) return;
        drawerDragPhase.set('dragging');
        drawerDragProgress.set(clampProgress(-deltaY / SHADE_DRAG_REVEAL_DISTANCE));
      },
      onEnd: (deltaY, velocity) => {
        if (get(isDrawerOpen)) return;
        drawerDragPhase.set('settling');
        if (shouldCommitDrag(get(drawerDragProgress), -velocity)) {
          drawerDragProgress.set(1);
          openDrawer();
        } else {
          drawerDragProgress.set(0);
        }
      }
    });
  });
</script>

<!-- Fixed 4-slot dock, always at the bottom of the home screen, above the phone frame's
     own home-indicator gesture bar. `bottom-10` rather than the `bottom-6` this used to
     share with the gesture bar's own height token — the two were sized off the same
     number coincidentally, not because a dock label's true bottom edge and the gesture
     bar's clear band actually lined up, and at `bottom-6` the label crowded the bar with
     only a few px between them. Never collapses to fewer than 4 cells — an unconfigured
     or unresolvable slot renders an empty placeholder rather than shrinking the row,
     since the dock's whole value is that a slot is always in the same place.

     No card background — a dock slot is a home-grid icon that happens to be pinned, not
     a visually distinct control, so it should look identical to one instead of sitting
     inside its own surface/shadow/rounded pill. `py-4` (not `py-2`) is deliberate too:
     the swipe-up-to-open-the-drawer gesture is attached to this whole element, and at
     `py-2` its hit area barely cleared the icons themselves — a drag starting just above
     or below an icon glyph had nothing to grab. The extra padding is graspable margin,
     not a layout change the icons themselves need.

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
  aria-label="Dock"
  class="absolute inset-x-0 bottom-10 z-20 grid cursor-pointer px-4 py-4 select-none"
  style="grid-template-columns: repeat({DOCK_SLOT_COUNT}, 1fr);"
>
  {#each slots as slot (slot.index)}
    <div data-dock-index={slot.index} class="flex items-center justify-center">
      {#if slot.manifest}
        <AppIcon
          name={slot.manifest.name}
          color={slot.manifest.color}
          icon={slot.manifest.icon}
          badgeStore={slot.manifest.badgeStore}
          onclick={() => {
            if (get(isDrawerOpen)) closeDrawer();
            openApp(slot.appId);
          }}
        />
      {:else}
        <div class="border-outline-variant h-14 w-14 rounded-sm border border-dashed"></div>
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
    class="text-on-surface-variant text-label-small pointer-events-none absolute inset-x-0 bottom-32 z-20 text-center select-none"
  >
    Swipe up for apps
  </p>
{/if}
