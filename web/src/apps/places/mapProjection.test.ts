// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  MAP_SIZE,
  MAX_ZOOM_FACTOR,
  centreOn,
  clampView,
  fitView,
  minZoom,
  toScreen,
  worldToMap,
  zoomAround
} from './mapProjection';

const bounds = { minX: -1000, minY: -2000, maxX: 1000, maxY: 2000 };

describe('worldToMap (MICA-244)', () => {
  it('puts the bounds on the edges of the square, north up', () => {
    expect(worldToMap(-1000, 2000, bounds)).toEqual({ mx: 0, my: 0 });
    expect(worldToMap(1000, -2000, bounds)).toEqual({ mx: MAP_SIZE, my: MAP_SIZE });
    expect(worldToMap(0, 0, bounds)).toEqual({ mx: MAP_SIZE / 2, my: MAP_SIZE / 2 });
  });

  it('flips y: further north is higher on screen', () => {
    expect(worldToMap(0, 1000, bounds).my).toBeLessThan(worldToMap(0, -1000, bounds).my);
  });
});

describe('the view', () => {
  const W = 400;
  const H = 600;

  it('fits the whole square across the shorter side, centred', () => {
    const view = fitView(W, H);
    expect(view.k).toBe(minZoom(W, H));
    expect(toScreen(MAP_SIZE / 2, MAP_SIZE / 2, view)).toEqual({ sx: W / 2, sy: H / 2 });
  });

  it('clamps zoom between fit and the maximum', () => {
    const lo = minZoom(W, H);
    expect(clampView({ k: lo / 10, tx: 0, ty: 0 }, W, H).k).toBe(lo);
    expect(clampView({ k: lo * 1000, tx: 0, ty: 0 }, W, H).k).toBe(lo * MAX_ZOOM_FACTOR);
  });

  it('never lets the square leave the centre of the element', () => {
    const view = clampView({ k: 1, tx: 99_999, ty: -99_999 }, W, H);
    expect(view.tx).toBe(W / 2);
    expect(view.ty).toBe(H / 2 - MAP_SIZE);
  });

  it('keeps the point under the pointer fixed while zooming', () => {
    const start = centreOn(300, 700, 2, W, H);
    const px = 120;
    const py = 250;
    const mx = (px - start.tx) / start.k;
    const my = (py - start.ty) / start.k;
    const next = zoomAround(start, 1.5, px, py, W, H);
    expect(next.k).toBeCloseTo(3);
    const at = toScreen(mx, my, next);
    expect(at.sx).toBeCloseTo(px);
    expect(at.sy).toBeCloseTo(py);
  });
});
