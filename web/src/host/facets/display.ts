// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import {
  displaySize,
  DISPLAY_SIZE_DEFAULT,
  isSizeLimited,
  phoneBox,
  phoneScale
} from '../../shell/state/display';
import {
  homeGridColumns,
  homeGridRows,
  HOME_GRID_COLUMNS_DEFAULT,
  HOME_GRID_COLUMNS_MIN,
  HOME_GRID_COLUMNS_MAX,
  HOME_GRID_ROWS_DEFAULT,
  HOME_GRID_ROWS_MIN,
  HOME_GRID_ROWS_MAX
} from '../../shell/state/homeGridSettings';
import {
  motionPreference,
  reducedMotion,
  MOTION_PREFERENCE_DEFAULT
} from '../../shell/state/motion';
import { activeDevice, frame } from '../../shell/state/device';

/**
 * How big the phone is drawn on screen — read-only. Its own hook rather than a corner of
 * `useSystemHardware`, for the reason `useClock` was split out: that hook means battery,
 * signal and the volume buttons, and how large the frame is rendered is none of those.
 *
 * Changing any of it — the size, the motion preference, the home grid — is
 * `useDisplayWrite` (MICA-127): it is the window's business, and the only app with a
 * reason to write it is Settings.
 */
export function display() {
  return {
    /** Which frame the app is in, and its design size (MICA-260). */
    device: activeDevice,
    frame,
    /** The Display > Phone Size setting, 0-100. */
    displaySize,
    /** Where the slider starts, so a Reset control needs no second copy of the number. */
    displaySizeDefault: DISPLAY_SIZE_DEFAULT,
    /** The zoom actually applied, after fitting to the window. Read-only. */
    phoneScale,
    /** The rendered size in CSS pixels, for showing the player what they picked. */
    phoneBox,
    /** True when the window is smaller than the setting asks for, and is winning. */
    isSizeLimited,

    /**
     * Motion. `motionPreference` is the player's three-way choice; `reducedMotion` is the
     * resolved answer after the platform's own `prefers-reduced-motion` has been folded
     * in, and is what an app would act on.
     */
    motionPreference,
    motionPreferenceDefault: MOTION_PREFERENCE_DEFAULT,
    reducedMotion,

    /** Home Screen Grid — columns/rows, and their adjustable bounds. */
    homeGridColumns,
    homeGridRows,
    homeGridColumnsDefault: HOME_GRID_COLUMNS_DEFAULT,
    homeGridColumnsMin: HOME_GRID_COLUMNS_MIN,
    homeGridColumnsMax: HOME_GRID_COLUMNS_MAX,
    homeGridRowsDefault: HOME_GRID_ROWS_DEFAULT,
    homeGridRowsMin: HOME_GRID_ROWS_MIN,
    homeGridRowsMax: HOME_GRID_ROWS_MAX
  };
}

registerFacet('display', display);
