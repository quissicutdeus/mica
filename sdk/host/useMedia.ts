// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * The media gallery — the client face of the `media` service.
 */
export function useMedia() {
  return guarded('useMedia').facets.media();
}
