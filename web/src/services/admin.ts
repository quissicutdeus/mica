// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { call } from '../nui/call';
import { adminContract } from '@mica/shared/contracts/admin';
import { isBrowser } from '@mica/sdk';

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

/**
 * Whether `isAdmin` holds the server's answer rather than the starting assumption or a failure.
 *
 * The sibling of `capabilities.ts`'s `capabilitiesKnown`, for the same reason. A failed ask
 * used to set `isAdmin` false and stop there, and `false` after a failure read exactly like
 * "this player holds no ace": nothing asked again until a forced bootstrap, and the first
 * ask is the one most likely to fail — it can reach `ServiceEndpoint`'s auth before a
 * character has loaded. So one failure at resource start hid Administration for the whole
 * session.
 *
 * **The failure still fails closed.** Unknown is hidden, the same as a refusal: this decides
 * whether an icon is drawn, and drawing it on a guess is the direction this repo will not
 * take. What changes is that unknown is no longer an answer, so `ensureAdmin` asks again.
 * A plain browser stands in as known, since it never asks.
 */
export const adminKnown = writable(isBrowser());

/** Module state rather than a store: the "is there anything left to ask" half, unrendered. */
let answered = false;

/**
 * Ask the server. Concurrent callers share one request; a later one re-reads.
 *
 * A failure — a transport error, an error reply, or a reply without a boolean `isAdmin` — is
 * hidden and unknown, never "not an admin". It does **not** keep a previous `true`: the ask
 * that fails may be a character switch's re-read, and the next character must not inherit
 * the last one's Administration icon on a bad connection.
 */
export const refreshAdmin = async (): Promise<void> => {
  if (isBrowser()) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res: unknown = await call(adminContract, 'check', undefined);
      const flag =
        res && typeof res === 'object' ? (res as { isAdmin?: unknown }).isAdmin : undefined;
      if (typeof flag !== 'boolean') throw new Error('admin:check answered without isAdmin');
      isAdmin.set(flag);
      adminKnown.set(true);
      answered = true;
    } catch {
      isAdmin.set(false);
      adminKnown.set(false);
      answered = false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
};

/**
 * Ask only if the last ask failed or never came; otherwise keep the answer in hand.
 *
 * What a phone open calls, so a failed ask is repaired on the next open instead of at the
 * next character switch. One in flight is shared. A character switch does not come through
 * here — the answer differs by character, so a forced bootstrap calls `refreshAdmin`.
 */
export const ensureAdmin = (): Promise<void> => {
  if (isBrowser()) return Promise.resolve();
  if (inFlight) return inFlight;
  if (answered) return Promise.resolve();
  return refreshAdmin();
};
