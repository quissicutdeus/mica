// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MediaPreview } from '@gphone/shared/types';

/**
 * A row from the "Recently Deleted" read (MICA-75-wiring) — `MediaPreview` plus the one
 * field that read has no use for and this one needs: when it was deleted, for
 * `RecentlyDeletedItem.deletedAt`. Server-projected to exactly this shape
 * (`server/services/Media.ts`'s `getDeleted`), not `MediaPreview` itself, since that type
 * deliberately carries no timestamp at all.
 *
 * MICA-172 moved it in from `services/media.ts` — see `./accounts.ts`. Not published.
 */
export type DeletedMediaItem = MediaPreview & { updated_at: string | Date };
