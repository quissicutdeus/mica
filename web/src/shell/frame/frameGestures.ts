// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import { anySheetOpen } from '../state/sheets';
import { currentApp } from '../state/navigation';
import { attachDragGesture, clampProgress, shouldCommitDrag } from '../../lib/phone/pointerDrag';
import { abandonSheetDrag, createSheetOpen, DRAWER_OPEN_COMMIT } from '../../lib/phone/sheetDrag';
import { openShade, shadeDragProgress, shadeDragPhase } from '../state/shade';
import {
  openControlCenter,
  controlCenterDragProgress,
  controlCenterDragPhase
} from '../state/controlCenter';
import { openDrawer, drawerDragProgress, drawerDragPhase } from '../state/appDrawer';

/**
 * The two drags a device's chrome owns, out of `PhoneFrame.svelte` so the tablet's frame
 * attaches the same ones (MICA-259). The reveal distance is the active device's height
 * (`shadeDragRevealDistance`); each caller reads the store inside the `$effect` that
 * attaches the gesture, so a change re-attaches rather than leaving a stale number behind.
 */

/**
 * Where on the status bar a pull starts decides which sheet it opens: the right-hand part
 * is the control center (MICA-247), the rest the notification shade. Read once at
 * `pointerdown`, so a drag that wanders sideways does not change its mind.
 */
export const CONTROL_CENTER_ZONE_START = 0.6;

export function statusBarZone(clientX: number, rect: { left: number; width: number }) {
  if (rect.width <= 0) return 'shade' as const;
  return (clientX - rect.left) / rect.width >= CONTROL_CENTER_ZONE_START
    ? ('controlCenter' as const)
    : ('shade' as const);
}

/** Pull the status bar down to open the notification shade or the control center. */
export function attachStatusBarDrag(element: HTMLElement, revealDistance: number) {
  let zone: 'shade' | 'controlCenter' = 'shade';
  const sheet = () =>
    zone === 'controlCenter'
      ? {
          progress: controlCenterDragProgress,
          phase: controlCenterDragPhase,
          open: openControlCenter
        }
      : { progress: shadeDragProgress, phase: shadeDragPhase, open: openShade };
  return attachDragGesture(element, {
    axis: 'y',
    // A dedicated grab surface: nothing horizontal shares these pixels.
    crossAxisCancel: false,
    shouldStart: (e) => {
      zone = statusBarZone(e.clientX, element.getBoundingClientRect());
      return true;
    },
    onMove: (deltaY) => {
      // `anySheetOpen`, not `isShadeOpen`: the status bar stays live underneath the
      // extended app drawer, so guarding only on the shade let this open a second sheet
      // on top of one already open (MICA-140).
      if (anySheetOpen()) return;
      const { progress, phase } = sheet();
      phase.set('dragging');
      progress.set(clampProgress(deltaY / revealDistance));
    },
    onEnd: (deltaY, velocity) => {
      if (anySheetOpen()) return;
      const { progress, phase, open } = sheet();
      phase.set('settling');
      if (shouldCommitDrag(get(progress), velocity)) {
        progress.set(1);
        open();
      } else {
        progress.set(0);
      }
    },
    // Written inline rather than through `createSheetOpen`, so the abandon is too.
    onCancel: () => abandonSheetDrag(sheet().phase)
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
