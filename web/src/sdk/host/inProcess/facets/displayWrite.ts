import { registerFacet } from '../../current';
import { get } from 'svelte/store';
import { setDisplaySize } from '../../../../shell/state/display';
import { homeGridColumns, homeGridRows } from '../../../../shell/state/homeGridSettings';
import { compactGridToCurrentCapacity } from '../../../../shell/state/homeGrid';
import { setMotionPreference } from '../../../../shell/state/motion';

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
     */
    setHomeGridSize: (columns: number, rows: number) => {
      if (get(homeGridColumns) !== columns) homeGridColumns.set(columns);
      if (get(homeGridRows) !== rows) homeGridRows.set(rows);
      compactGridToCurrentCapacity();
    }
  };
}

registerFacet('displayWrite', displayWrite);
