// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['camera']>>;

export function camera(): Twin {
  return {
    isTakingPhoto: store('camera', [], 'isTakingPhoto', false),
    isPreviewingPhoto: store('camera', [], 'isPreviewingPhoto', false)
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('camera', camera as unknown as Facets['camera']);
