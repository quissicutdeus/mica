import {
  displaySize,
  setDisplaySize,
  DISPLAY_SIZE_DEFAULT,
  isSizeLimited,
  phoneBox,
  phoneScale
} from '../../shell/state/display';

/**
 * How big the phone is drawn on screen.
 *
 * Its own hook rather than a corner of `useSystemHardware`, for the reason `useClock`
 * was split out: that hook means battery, signal and the volume buttons, and how large
 * the frame is rendered is none of those. It is the window's business, and the only app
 * with a reason to touch it is Settings.
 */
export function useDisplay() {
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
    isSizeLimited
  };
}
