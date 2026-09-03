// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEVICES, type DeviceDescriptor } from '@gphone/shared/devices';
import { perDevice } from './device';

/**
 * The phone's grid, by name, for the places that are about the phone rather than about
 * whichever device is active: the `display` facet's published bounds and the Settings
 * pane that draws them. Per-device Settings is MICA-261; until then these are the
 * phone's row of the table, unchanged in value.
 */
export const HOME_GRID_COLUMNS_DEFAULT = DEVICES.phone.launcher.columns;
export const HOME_GRID_ROWS_DEFAULT = DEVICES.phone.launcher.rows;
export const HOME_GRID_COLUMNS_MIN = DEVICES.phone.launcher.columnRange[0];
export const HOME_GRID_COLUMNS_MAX = DEVICES.phone.launcher.columnRange[1];
export const HOME_GRID_ROWS_MIN = DEVICES.phone.launcher.rowRange[0];
export const HOME_GRID_ROWS_MAX = DEVICES.phone.launcher.rowRange[1];

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * Into the device's own range (MICA-259): 3-5 columns on the phone, 6-10 on the tablet.
 * The device defaults to the phone so a caller with no device in hand — a test, the
 * facet — clamps the way it always has.
 */
export const clampColumns = (value: unknown, device: DeviceDescriptor = DEVICES.phone): number =>
  clamp(
    value,
    device.launcher.columnRange[0],
    device.launcher.columnRange[1],
    device.launcher.columns
  );

export const clampRows = (value: unknown, device: DeviceDescriptor = DEVICES.phone): number =>
  clamp(value, device.launcher.rowRange[0], device.launcher.rowRange[1], device.launcher.rows);

/**
 * One value per device, following `activeDevice` — see `perDevice`. The phone's key is
 * the one it always was, so an existing save still means the phone.
 */
export const homeGridColumns = perDevice<number>(
  'homeGridColumns',
  (device) => device.launcher.columns,
  clampColumns
);

export const homeGridRows = perDevice<number>(
  'homeGridRows',
  (device) => device.launcher.rows,
  clampRows
);
