import { registerFacet } from '../../current';
import { get } from 'svelte/store';
import {
  displaySize,
  setDisplaySize,
  DISPLAY_SIZE_DEFAULT,
  isSizeLimited,
  phoneBox,
  phoneScale
} from '../../../../shell/state/display';
import {
  homeGridColumns,
  homeGridRows,
  HOME_GRID_COLUMNS_DEFAULT,
  HOME_GRID_COLUMNS_MIN,
  HOME_GRID_COLUMNS_MAX,
  HOME_GRID_ROWS_DEFAULT,
  HOME_GRID_ROWS_MIN,
  HOME_GRID_ROWS_MAX
} from '../../../../shell/state/homeGridSettings';
import { compactGridToCurrentCapacity } from '../../../../shell/state/homeGrid';

/**
 * How big the phone is drawn on screen.
 *
 * Its own hook rather than a corner of `useSystemHardware`, for the reason `useClock`
 * was split out: that hook means battery, signal and the volume buttons, and how large
 * the frame is rendered is none of those. It is the window's business, and the only app
 * with a reason to touch it is Settings.
 */
export function display() {
  return {
    /** The Display > Phone Size setting, 0-100. Writable: Settings moves it. */
    displaySize,
    setDisplaySize,
    /** Where the slider starts, so a Reset control needs no second copy of the number. */
    displaySizeDefault: DISPLAY_SIZE_DEFAULT,
    /** The zoom actually applied, after fitting to the window. Read-only. */
    phoneScale,
    /** The rendered size in CSS pixels, for showing the player what they picked. */
    phoneBox,
    /** True when the window is smaller than the setting asks for, and is winning. */
    isSizeLimited,

    /** Home Screen Grid — columns/rows, and their adjustable bounds. */
    homeGridColumns,
    homeGridRows,
    homeGridColumnsDefault: HOME_GRID_COLUMNS_DEFAULT,
    homeGridColumnsMin: HOME_GRID_COLUMNS_MIN,
    homeGridColumnsMax: HOME_GRID_COLUMNS_MAX,
    homeGridRowsDefault: HOME_GRID_ROWS_DEFAULT,
    homeGridRowsMin: HOME_GRID_ROWS_MIN,
    homeGridRowsMax: HOME_GRID_ROWS_MAX,
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

registerFacet('display', display);
