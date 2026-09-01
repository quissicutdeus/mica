<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { get } from 'svelte/store';
  import { attachDragGesture } from '../lib/phone/pointerDrag';
  import { createSheetOpen, DRAWER_OPEN_COMMIT } from '../lib/phone/sheetDrag';
  import { isDrawerOpen, openDrawer, drawerDragProgress, drawerDragPhase } from './state/appDrawer';
  import { SHADE_DRAG_REVEAL_DISTANCE } from './state/display';
  import SearchIcon from '../../../sdk/ui/icons/SearchIcon.svelte';

  /** Just the pill that opens the (now-merged) App Drawer, always focused there. */
  let collapsedBarRef = $state<HTMLElement | null>(null);

  const openDrag = createSheetOpen({
    direction: 'up',
    progress: drawerDragProgress,
    phase: drawerDragPhase,
    revealDistance: SHADE_DRAG_REVEAL_DISTANCE,
    guard: () => !get(isDrawerOpen),
    open: openDrawer,
    commit: DRAWER_OPEN_COMMIT
  });

  $effect(() => {
    if (!collapsedBarRef) return;
    return attachDragGesture(collapsedBarRef, {
      axis: 'y',
      crossAxisCancel: false,
      onMove: openDrag.onMove,
      onEnd: openDrag.onEnd,
      onCancel: openDrag.abandon
    });
  });
</script>

<!-- `bottom-8` sits between the home bar (`bottom-0`) and the Dock (`bottom-20`).
     Hidden while the drawer is open — it carries its own copy of this input. -->
{#if !$isDrawerOpen}
  <div class="absolute inset-x-0 bottom-8 z-20 px-4">
    <button
      bind:this={collapsedBarRef}
      type="button"
      onclick={openDrawer}
      class="bg-surface-container-high text-on-surface-variant text-body-medium shadow-elevation-2 duration-short ease-standard flex h-11 w-full cursor-pointer items-center gap-2 rounded-box px-4 backdrop-blur-md transition-colors hover:brightness-110"
      aria-label="Search"
    >
      <SearchIcon class="h-4 w-4" />
      <span>Search</span>
    </button>
  </div>
{/if}
