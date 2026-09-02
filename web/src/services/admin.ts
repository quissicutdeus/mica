// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { call } from '../nui/call';
import { adminContract } from '@gphone/shared/contracts/admin';
import { isBrowser } from '@gphone/sdk';

/**
 * Whether the player holds an admin ace, as decided by the server.
 *
 * One store rather than each screen asking for itself. Settings already fetched this
 * privately to gate Developer Tools, and the home screen needs the same answer to
 * decide whether the Administration app exists — two copies of one fact drift, and the
 * whole point of asking the server is that there is a single authority.
 *
 * It decides what the UI *shows* and nothing more. Every privileged action is checked
 * again server-side, because a NUI request is not proof of intent (AGENTS.md §2.9).
 *
 * A plain browser has no ace list and no server to ask, so it stands in as allowed.
 */
export const isAdmin = writable(isBrowser());

/**
 * The request in flight, if there is one — not a "we have asked once" latch.
 *
 * It was the latch, a module-scope `let asked = false` that never cleared, and that was a
 * defect rather than a policy. `pushRehydrate` on a character switch calls
 * `resetBootstrapState()` and `bootstrapStores(true)` (`shell/nuiMessages.ts`), which calls
 * this again — and the latch swallowed it, so the ace list was read once for whoever was
 * behind the phone first and the next character inherited their Administration icon for the
 * rest of the CEF page's life. The page never unloads in game, so "once per session" meant
 * once per resource start, not once per player.
 *
 * De-duplicating on the promise keeps the only property the latch was actually wanted for —
 * several callers at boot cost one request — while letting a later call ask again.
 */
let inFlight: Promise<void> | null = null;

/** Ask the server. Concurrent callers share one request; a later one re-reads. */
export const refreshAdmin = async (): Promise<void> => {
  if (isBrowser()) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await call(adminContract, 'check', undefined);
      isAdmin.set(res?.isAdmin === true);
    } catch {
      isAdmin.set(false);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
};
