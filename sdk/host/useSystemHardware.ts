// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * The phone's hardware: battery, cellular signal, cell service, bluetooth, and volume
 * controls — read-only. Changing any of it is `useSystemHardwareWrite` (MICA-127).
 */
export function useSystemHardware() {
  return guarded('useSystemHardware').facets.systemHardware();
}
