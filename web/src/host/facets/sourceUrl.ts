// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { refreshSourceUrl, sourceUrl } from '../../services/sourceUrl';

/**
 * OS Service Hook for where this server says its source lives (MICA-192, AGPL §13).
 *
 * A facet rather than a relative import from the pane that shows it: Settings is an app,
 * and an app reaches the OS through `@gphone/sdk` alone (AGENTS.md §2.7, enforced by
 * `sdk/boundary.test.ts`). `useService('shell')` is not the door either — `permissions.ts`
 * restricts that id to the calling app's own.
 *
 * Read-only as far as apps are concerned. It reflects a convar the operator set, and
 * nothing an app does changes it.
 */
export function sourceUrlFacet() {
  return { sourceUrl, refreshSourceUrl };
}

registerFacet('sourceUrl', sourceUrlFacet);
