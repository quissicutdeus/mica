// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two lookups the queue and the detail pane share (MICA-261).
 *
 * Catalog *keys*, not text: both roots render them through `$t`, so the phone and the
 * tablet cannot drift apart into two half-translated wordings of the same category. A
 * category or resolution the server sends that is not in here falls back to its raw
 * value at the call site, which is a missing catalog entry rather than a blank screen.
 */
export const CATEGORY_KEYS: Record<string, string> = {
  spam: 'admin.categorySpam',
  harassment: 'admin.categoryHarassment',
  threats: 'admin.categoryThreats',
  sexual: 'admin.categorySexual',
  impersonation: 'admin.categoryImpersonation',
  other: 'admin.categoryOther'
};

export const RESOLUTION_KEYS: Record<string, string> = {
  actioned: 'admin.resolutionActioned',
  dismissed: 'admin.resolutionDismissed'
};

/** A photo's stored preview is a base64 data URI; anything else is text. */
export const isImage = (preview?: string): boolean => Boolean(preview?.startsWith('data:image'));

/** Which way a pending report is being decided. */
export type ResolveAction = 'moderate' | 'dismiss';
