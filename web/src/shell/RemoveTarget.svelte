<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import TrashIcon from '../../../sdk/ui/icons/TrashIcon.svelte';
  import { iconDragState, isRemovableOrigin } from './state/iconDrag';

  let element = $state<HTMLElement | null>(null);

  let drag = $derived($iconDragState);
  let shown = $derived(Boolean(drag.appId) && isRemovableOrigin(drag.origin));

  /**
   * Armed = the pointer is currently inside the pill, so the release that ends the drag
   * will land here. `iconDragState.x/y` are real viewport pixels and
   * `getBoundingClientRect()` reports the same space — including `Shell.svelte`'s
   * `transform: scale()` on an ancestor — so the two compare directly, with none of the
   * scale correction `DragGhost.svelte` needs to *position* itself in local coordinates.
   *
   * Measuring the element rather than reusing `resolveDropAtPoint` is deliberate: that
   * function answers "which target wins", which is the drop's question. This one only has
   * to know whether the pointer is over *this* pill, and asking the element itself keeps
   * the highlight honest no matter what else is stacked underneath it.
   */
  let armed = $derived.by(() => {
    if (!shown || !element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0) return false;
    return (
      drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom
    );
  });
</script>

<!-- The one way to take an app back off the home screen (MICA-87). Long-pressing an icon
     pinned it and nothing undid that: `resolveIconDrop`'s only removals were side effects
     of putting the app somewhere *else*, and a drop that hit nothing cancelled rather than
     removed — so a pinned icon could be moved forever and never taken away.

     It appears on the long-press, which is the moment the player is already looking for
     what a held icon can do, rather than living behind a gesture they would have to be
     told about. `isRemovableOrigin` keeps it off a drawer drag: the drawer is where an
     unpinned app already lives, so offering to remove one from there would read as
     uninstalling it.

     Top-centered, not bottom: the bottom third of the screen is the dock (itself a drop
     target), the collapsed search bar and the home indicator, and a fourth target stacked
     into that band would be a coin toss on every drop. `top-10` clears the status bar's
     own text (`top-0` plus `pt-3`) without reaching the first icon row.

     `z-65` — above the folder popup (`z-56`) and the status bar (`z-60`), so it is
     reachable while dragging an app out of an open folder, and below the drag ghost
     (`z-70`), which must stay on top of the thing it is being dragged onto.

     The armed state is a colour swap and nothing else. A scale-up would read well and is
     not available: `app-utilities.css`'s transform utilities each set the whole `transform`
     property rather than composing through custom properties, so `scale-110` would replace
     the `-translate-x-1/2` that centers this pill and jerk it half its own width to the
     right at the exact moment the player is aiming at it.

     No `pointer-events-none`, unlike `DragGhost.svelte` directly below it: that is exactly
     what keeps the ghost *out* of `elementsFromPoint`, and this pill has to be found by
     that same hit test (`data-drop-remove`) or the drop can never resolve here. It cannot
     steal the gesture by being hit-testable — the source icon holds the pointer capture
     for the whole drag, the same as it does over a dock slot or a grid cell. -->
{#if shown}
  <div
    bind:this={element}
    data-drop-remove
    data-testid="remove-drop-target"
    class="duration-short ease-standard absolute top-10 left-1/2 z-65 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 whitespace-nowrap shadow-elevation-3 transition-all select-none"
    class:bg-error={armed}
    class:text-on-error={armed}
    class:bg-surface-container-highest={!armed}
    class:text-on-surface={!armed}
  >
    <TrashIcon class="size-icon-sm" />
    <span class="text-label-large">Remove</span>
  </div>
{/if}
