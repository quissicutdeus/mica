// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Listing } from '@mica/shared/types';

/** What `Facets['marketplace']` reads and writes. MICA-172 — see `./accounts.ts`. */

/** A page of marketplace listings, as returned by the feed/search/mine reads. */
export interface ListingPage {
  rows: Listing[];
  nextCursor: number | null;
}

/** What `postListing` takes to create a new marketplace listing. */
export interface CreateListingInput {
  title: string;
  price: number;
  description: string;
  attachments: { photo_id: number }[];
}
