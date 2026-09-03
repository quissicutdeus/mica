// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import { anySheetOpen } from '../state/sheets';
import { currentApp } from '../state/navigation';
import { attachDragGesture, clampProgress, shouldCommitDrag } from '../../lib/phone/pointerDrag';
import { abandonSheetDrag, createSheetOpen, DRAWER_OPEN_COMMIT } from '../../lib/phone/sheetDrag';
import { openShade, shadeDragProgress, shadeDragPhase } from '../state/shade';
import { openDrawer, drawerDragProgress, drawerDragPhase } from '../state/appDrawer';

/**
 * The two drags a device's chrome owns, out of `PhoneFrame.svelte` so the tablet's frame
 * attaches the same ones (MICA-259). The reveal distance is the active device's height
 * (`shadeDragRevealDistance`); each caller reads the store inside the `$effect` that
 * attaches the gesture, so a change re-attaches rather than leaving a stale number behind.
 */

/** Pull the status bar down to open the notification shade. */
export function attachStatusBarDrag(element: HTMLElement, revealDistance: number) {
  return attachDragGesture(element, {
    axis: 'y',
    // A dedicated grab surface: nothing horizontal shares these pixels.
    crossAxisCancel: false,
    onMove: (deltaY) => {
      // `anySheetOpen`, not `isShadeOpen`: the status bar stays live underneath the
      // extended app drawer, so guarding only on the shade let this open a second sheet
      // on top of one already open (MICA-140).
      if (anySheetOpen()) return;
      shadeDragPhase.set('dragging');
      shadeDragProgress.set(clampProgress(deltaY / revealDistance));
    },
    onEnd: (deltaY, velocity) => {
      if (anySheetOpen()) return;
      shadeDragPhase.set('settling');
      if (shouldCommitDrag(get(shadeDragProgress), velocity)) {
        shadeDragProgress.set(1);
        openShade();
      } else {
        shadeDragProgress.set(0);
      }
    },
    // Written inline rather than through `createSheetOpen`, so the abandon is too.
    onCancel: () => abandonSheetDrag(shadeDragPhase)
  });
}

/** Swipe the home indicator up to open the app drawer, from the home screen only (MICA-45). */
export function attachHomeBarDrag(element: HTMLElement, revealDistance: number) {
  const openDrag = createSheetOpen({
    direction: 'up',
    progress: drawerDragProgress,
    phase: drawerDragPhase,
    revealDistance,
    guard: () => get(currentApp).id === 'home' && !anySheetOpen(),
    open: openDrawer,
    commit: DRAWER_OPEN_COMMIT
  });
  return attachDragGesture(element, {
    axis: 'y',
    crossAxisCancel: false,
    onMove: openDrag.onMove,
    onEnd: openDrag.onEnd,
    onCancel: openDrag.abandon
  });
}
