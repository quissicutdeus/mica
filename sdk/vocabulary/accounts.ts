// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Account } from '@mica/shared/types';

/**
 * The social-identity nouns `Facets['accounts']` is written in terms of. MICA-172.
 *
 * These were declared in `web/src/services/accounts.ts` and imported back into the SDK,
 * so the package defined its published vocabulary in terms of a module belonging to its
 * consumer. `useAccounts` then re-exported three of them *out through the phone*, which is
 * the same inversion `facets.ts` was authored to end: a contract whose nouns are borrowed
 * is a contract that moves when the borrower does.
 *
 * They live here now and the phone imports them back. One definition each, and nothing in
 * `sdk/` reaches outside the package to find it.
 */

export interface ReactionTarget {
  app: string;
  target_table: string;
  target_ids: number[];
}

export interface FollowPage {
  rows: Account[];
  nextCursor: number | null;
}

export interface FollowListQuery {
  app: string;
  account_id: number;
  cursor?: number;
  limit?: number;
}

export interface AccountSearchQuery {
  app: string;
  q: string;
  cursor?: number;
  limit?: number;
}
