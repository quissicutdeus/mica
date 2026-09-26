// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TransactionQuery } from '../Database';

/**
 * Where imported posts go (MICA-233), declared by the app that takes them.
 *
 * Core does not name a Store add-on (`sdk/coreBoundary.test.ts`), and the app that takes an old
 * phone's tweets is one. So the importer knows only this shape: the app's own server service
 * registers a `PostsTarget` at load, carrying everything specific to it — which table its
 * accounts and posts live in, how a source username becomes one of its handles, its per-app
 * account cap, the post `INSERT` — and `micaimport` calls whatever is registered. With nothing
 * registered (the app not installed), or the registered app switched off by the owner, every
 * account and post row is counted under a reason and nothing is written.
 *
 * Every statement a target returns must name its tables and columns as literals and bind every
 * value, the same rule as the rest of the importer (§2.9).
 */

/** A source account, as the importer read it. */
export interface ImportedAccount {
  handle: string;
  displayName?: string | null;
  avatar?: string | null;
  bio?: string | null;
}

/**
 * What a source account becomes: an existing account to link (`folded` when that is because the
 * character is at the per-app cap), a new one to create with this `INSERT`, or `'none'` when no
 * handle is free. Planned with reads only, so a dry run plans the same way.
 */
export type AccountPlan = { link: number; folded: boolean } | { create: TransactionQuery } | 'none';

export interface PostWrite {
  citizenid: string;
  accountId: number;
  body: string | null;
  replyTo: number | null;
  rootId: number | null;
  mouthOf: number | null;
  at: Date | null;
}

export interface PostsTarget {
  /** The app id, for the owner's disabled list. */
  app: string;
  /** The ledger's `target_table` for accounts and for posts. */
  accountTable: string;
  postTable: string;
  /** The longest body a post may have. */
  maxBody: number;
  planAccount(citizenid: string, account: ImportedAccount): Promise<AccountPlan>;
  insertPost(post: PostWrite): TransactionQuery;
  /** Who owns an account, for a post whose account was linked in an earlier run. */
  ownerOf(accountId: number): Promise<string | null>;
  /** A post's thread root, or null when it is a root. */
  rootOf(postId: number): Promise<number | null>;
  /** Whether this account already repeats that post (the repeat is unique per account). */
  repeats(accountId: number, postId: number): Promise<boolean>;
}

let posts: PostsTarget | null = null;

/** Called by the app that takes imported posts, from its own service file, at load. */
export const registerImportTarget = (kind: 'posts', target: PostsTarget): void => {
  if (kind === 'posts') posts = target;
};

export const postsTarget = (): PostsTarget | null => posts;

/** Test seam. */
export const __resetImportTargets = (): void => {
  posts = null;
};
