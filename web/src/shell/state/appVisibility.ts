// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived } from 'svelte/store';
import { isAdmin } from '../../services/admin';
import { capabilities } from '../../services/capabilities';
import { manifestVisible } from '../../lib/phone/appVisibility';
import type { AppManifest } from '../../../../sdk/manifest';

/**
 * `lib/appVisibility.ts`'s rule, wired to the two stores that answer it — one question,
 * five launcher surfaces, and a surface added later gets both axes by asking the same way.
 *
 * A derived store *containing a function* rather than a hand-written `$derived` block per
 * surface, for the reason `notificationPolicy.ts`'s `badgeAllowed` gives: `$appVisible(m)`
 * is one reactive expression per site, it recomputes when either input moves because the
 * function's identity moves with them, and it allocates no store per icon the way a
 * `derived()` factory called inside an `{#each}` would.
 *
 * Reactivity is the point on two of these. `FolderPopup` read `get(isAdmin)` — a one-shot
 * read inside a `$derived`, so the list never re-ran when the answer it depends on changed;
 * invisible while the only such answer arrived before first paint, and wrong the moment a
 * second one landed after it, which `refreshCapabilities` does by construction.
 */
export const appVisible = derived(
  [isAdmin, capabilities],
  ([$isAdmin, $capabilities]) =>
    (manifest: AppManifest | null | undefined): boolean =>
      manifestVisible(manifest, { isAdmin: $isAdmin, capabilities: $capabilities })
);
