import { registerFacet } from '../../current';
import { get } from 'svelte/store';
import { setDisplaySize } from '../../../../shell/state/display';
import { homeGridColumns, homeGridRows } from '../../../../shell/state/homeGridSettings';
import {
  compactGridToCurrentCapacity,
  itemsBeyondCapacity
} from '../../../../shell/state/homeGrid';
import { setMotionPreference } from '../../../../shell/state/motion';
import { toast } from '../../../../shell/state/toast';

/**
 * Implementation of the `useDisplayWrite` facet — see the `useDisplayWrite` hook doc for
 * the usage contract. Split out of `display` (MICA-127): reading how big the phone is
 * drawn and resizing it — or rebuilding the home grid, or overriding motion for every app
 * on the phone — are not the same ask.
 */
export function displayWrite() {
  return {
    setDisplaySize,
    setMotionPreference,
    /**
     * Applies a new grid size and reflows anything the shrink pushed out of bounds. The
     * setter alone would leave those items structurally valid but unreachable — a shrink
     * is the one time `homeGridItems` needs touching from outside `homeGrid.ts` itself, so
     * this bundles the write and the reflow into one call rather than asking every caller
     * to remember the second step.
     *
     * MICA-121: checked *before* either store is touched, and refused outright if the new
     * size can't hold every item — not applied-then-partially-undone. The grid's own
     * capacity never changes as a side effect of a resize the player never agreed to, and
     * the toast tells them why the stepper in Settings > Display didn't move.
     */
    setHomeGridSize: (columns: number, rows: number) => {
      const blocked = itemsBeyondCapacity(columns * rows);
      if (blocked > 0) {
        toast.show({
          type: 'warning',
          message: `Can't shrink the grid — ${blocked} ${blocked === 1 ? 'item' : 'items'} on the home screen would have nowhere to go. Remove some first.`
        });
        return;
      }
      if (get(homeGridColumns) !== columns) homeGridColumns.set(columns);
      if (get(homeGridRows) !== rows) homeGridRows.set(rows);
      compactGridToCurrentCapacity();
    }
  };
}

registerFacet('displayWrite', displayWrite);
