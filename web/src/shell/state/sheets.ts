import { derived, get, type Readable } from 'svelte/store';
import { isShadeOpen } from './shade';
import { isDrawerOpen } from './appDrawer';

/**
 * True while either full-screen sheet is open — the notification shade or the app drawer.
 *
 * **One expression, because four gestures need the same answer and three of them wrote it
 * out by hand.** Each of the four ways to open a sheet guarded against a different subset:
 * the Launcher's home-screen swipe checked both sheets, `PhoneFrame`'s home-bar pull checked
 * both, `Dock`'s pull checked only the drawer, and `PhoneFrame`'s status-bar pull checked
 * only the shade. That last one is the reported bug (MICA-140) — the status bar stays
 * live under the extended app drawer, so pulling it down opened the shade on top of a sheet
 * that was already open, and neither could then be dismissed by its own handle.
 *
 * The two are mutually exclusive by design: each is the whole screen, each registers its own
 * `back` handler, and each has a close gesture that assumes it is the thing on top. Four
 * copies of that rule is four places for it to stop being the same rule, which is what
 * happened.
 *
 * **Only the four *open* gestures consult this.** A sheet's own close gesture must keep
 * working while that sheet is open, which is precisely when this is true.
 */
export const isAnySheetOpen: Readable<boolean> = derived(
  [isShadeOpen, isDrawerOpen],
  ([shade, drawer]) => shade || drawer
);

/**
 * The same question inside a gesture callback, where a subscription is the wrong shape.
 *
 * The drag handlers are plain functions rather than components, so they read stores with
 * `get` — this keeps the invariant one import instead of two at every call site.
 */
export const anySheetOpen = (): boolean => get(isAnySheetOpen);
