// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MapBounds } from '@mica/shared/contracts/places';

/**
 * GTA world space to map space, and the pan/zoom arithmetic over it (MICA-244).
 *
 * The map is a square of `MAP_SIZE` user units whatever the owner's image is: the image is
 * stretched to it, and the world bounds say which world rectangle the square covers. World y
 * grows north and screen y grows down, so v is flipped.
 *
 * A view is `{ k, tx, ty }`: screen = t + k * map, in the map element's own layout pixels —
 * not client pixels, which the phone's `transform: scale()` makes a different unit.
 */
export const MAP_SIZE = 1000;

/** How far past "whole map fits" the player may zoom in. */
export const MAX_ZOOM_FACTOR = 24;

/** What the map opens at when it has a position to centre on, relative to "whole map fits". */
export const FOCUS_ZOOM_FACTOR = 6;

export interface MapView {
  k: number;
  tx: number;
  ty: number;
}

/** A world point's place on the map square, in map units. May fall outside it. */
export const worldToMap = (
  x: number,
  y: number,
  bounds: MapBounds
): { mx: number; my: number } => ({
  mx: ((x - bounds.minX) / (bounds.maxX - bounds.minX)) * MAP_SIZE,
  my: ((bounds.maxY - y) / (bounds.maxY - bounds.minY)) * MAP_SIZE
});

export const minZoom = (width: number, height: number): number =>
  Math.min(width, height) / MAP_SIZE;

/**
 * Keep some of the map on screen: the square may be dragged until its edge reaches the centre
 * of the element, and no further, so the player can never lose it off one side.
 */
export const clampView = (view: MapView, width: number, height: number): MapView => {
  const lo = minZoom(width, height);
  const k = Math.min(lo * MAX_ZOOM_FACTOR, Math.max(lo, view.k));
  const span = MAP_SIZE * k;
  const clamp = (t: number, size: number) => Math.min(size / 2, Math.max(size / 2 - span, t));
  return { k, tx: clamp(view.tx, width), ty: clamp(view.ty, height) };
};

/** A view with map point (mx, my) at the element's centre, at zoom `k`. */
export const centreOn = (
  mx: number,
  my: number,
  k: number,
  width: number,
  height: number
): MapView => clampView({ k, tx: width / 2 - mx * k, ty: height / 2 - my * k }, width, height);

/** The whole square, centred. */
export const fitView = (width: number, height: number): MapView =>
  centreOn(MAP_SIZE / 2, MAP_SIZE / 2, minZoom(width, height), width, height);

/** Zoom by `factor`, keeping the map point under (px, py) — element pixels — where it is. */
export const zoomAround = (
  view: MapView,
  factor: number,
  px: number,
  py: number,
  width: number,
  height: number
): MapView => {
  const next = clampView({ ...view, k: view.k * factor }, width, height);
  const ratio = next.k / view.k;
  return clampView(
    { k: next.k, tx: px - (px - view.tx) * ratio, ty: py - (py - view.ty) * ratio },
    width,
    height
  );
};

/** Where a map point lands in the element, under a view. */
export const toScreen = (mx: number, my: number, view: MapView): { sx: number; sy: number } => ({
  sx: view.tx + mx * view.k,
  sy: view.ty + my * view.k
});

/**
 * How many layout pixels one client pixel is on this element.
 *
 * The shell answers the same question for its own gestures (`measureDragRatio`,
 * `web/src/lib/phone/dragRatio.ts`), but that module is the shell's and an app may reach only
 * `@mica/sdk` (AGENTS.md §2.7). Same measurement, same fallback: zero on either side means
 * nothing is laid out yet, so no correction.
 */
export const renderScale = (element: HTMLElement): number => {
  const rendered = element.getBoundingClientRect().width;
  const layout = element.offsetWidth;
  return rendered > 0 && layout > 0 ? rendered / layout : 1;
};
