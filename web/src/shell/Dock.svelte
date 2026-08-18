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
     since the dock's whole value is that a slot is always in the same place. -->
<div
  bind:this={dockElement}
  role="toolbar"
  aria-label="Dock"
  class="absolute inset-x-0 bottom-10 z-20 flex justify-around px-6 select-none"
>
  {#each slots as slot (slot.index)}
    <div data-dock-index={slot.index} class="flex h-16 w-16 items-center justify-center">
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
        <div class="border-outline-variant h-14 w-14 rounded-lg border border-dashed"></div>
      {/if}
    </div>
  {/each}
</div>
