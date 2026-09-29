// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useNuiBridge } from '@mica/sdk/core';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import type { PrivacyDeleteResult, PrivacyExport, PrivacyExportCategory } from '@mica/shared/types';

/**
 * The logic behind Settings > Privacy > Your data (MICA-168), kept out of the pane so it
 * can be tested without mounting one. The shapes are `shared/contracts/privacy.ts`'s.
 */

/**
 * Both calls ride the generic service action through the raw transport. Settings is a
 * `core` app and cannot import `nui/call.ts` (`sdk/boundary.test.ts`), and `useService` is
 * refused for any id outside the app's own namespace (`sdk/permissions.test.ts`) — the same
 * reason `ownerWallpapers.ts` reaches `shell` this way.
 *
 * No `defaultValue` on either: a failed read or delete must throw so the pane can say so. A
 * default of `{ categories: [] }` would read as "micaOS holds nothing for you", which is the
 * wrong thing to tell a player whose export merely failed.
 */
const privacy = <T>(action: 'export' | 'delete', data: Record<string, unknown>): Promise<T> =>
  useNuiBridge().fetchNui<T>(GENERIC_SERVICE_ACTION, { service: 'privacy', action, data });

export const loadExport = (): Promise<PrivacyExport> => privacy<PrivacyExport>('export', {});

export const requestDelete = (confirm: string): Promise<PrivacyDeleteResult> =>
  privacy<PrivacyDeleteResult>('delete', { confirm });

/**
 * Categories to list, in the server's order: any with rows, and any the server cut. A
 * category cut for size arrives with no rows at all, and dropping it for that would tell the
 * player micaOS holds nothing there, when the truth is that it was left out of the view.
 */
export const listed = (data: PrivacyExport): PrivacyExportCategory[] =>
  data.categories.filter((c) => c.rows.length > 0 || c.truncated !== false);

/** True only when the export is whole and empty. A cut export never proves "nothing held". */
export const holdsNothing = (data: PrivacyExport): boolean =>
  !data.truncated && data.categories.every((c) => c.truncated === false && c.rows.length === 0);

/** The whole export as the text "Copy all as JSON" puts on the clipboard. */
export const exportJson = (data: PrivacyExport): string => JSON.stringify(data, null, 2);

/** One category's rows, pretty-printed for the scrollable view. */
export const rowsJson = (category: PrivacyExportCategory): string =>
  JSON.stringify(category.rows, null, 2);

/**
 * What the client relay answers when 15 seconds pass with no reply (`ServiceProxy.relay`).
 * For a delete it means the server may still be purging, not that nothing happened.
 */
export const RELAY_TIMEOUT = 'Request timed out';

export const isRelayTimeout = (e: unknown): boolean =>
  e instanceof Error && e.message === RELAY_TIMEOUT;

/** `messages_participants` → `messages participants`, for a category the catalog lacks. */
export const humanize = (category: string): string => category.replace(/_/g, ' ');

/**
 * `done` only when the server says `complete`. A partial delete is never shown as a whole
 * one, so this trusts `complete` and the failure list together: either says partial.
 */
export const outcomeOf = (result: PrivacyDeleteResult): 'done' | 'partial' =>
  result.complete && result.failed.length === 0 ? 'done' : 'partial';
