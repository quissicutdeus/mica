// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Readable } from 'svelte/store';

/**
 * How long a read made through `freshRead` counts as fresh (MICA-446).
 *
 * Contacts uses it for one read only: the conversations behind a contact's "recent
 * messages", read when the details screen opens. Between reads the conversations store is
 * kept current by push: `deliverToParticipants` (`server/services/Messages.ts`) sends every
 * online, unblocking recipient a `mica:client:messages:received`, for a player's text and for
 * the `SendMessage` export alike, and the shell's `receiveMessage` hands it to
 * `addReceivedMessage`, which updates or prepends the thread. What no push carries is a
 * thread's member list, so a group thread first seen by push matches a contact by member only
 * after the next read, at most this long later.
 *
 * The contacts list itself is not read through this: the `AddContact` export writes contacts
 * on the server with no push, so Contacts reads its list on every foreground.
 */
export const FRESH_FOR_MS = 60_000;

/**
 * When each read last came back with an answer, by key.
 *
 * Module scope, not the component's, on purpose: an app pushed out of the residency LRU
 * remounts, and a remount a few seconds after the last read is not a reason to read again.
 */
const answeredAt = new Map<string, number>();

/**
 * A read that is skipped while the last answer is fresh.
 *
 * The facet gives an app a store's `loaded` but not its `error`, and `load()` resolves
 * whether or not the read worked. What does tell them apart is the store itself: an answer
 * replaces the list, which emits, and a failed read leaves it untouched. So a read counts
 * as answered only if the store emitted while it was in flight; a failed one leaves the
 * stamp where it was, and the next call is the retry.
 *
 * Calls made while a read is in flight share it rather than start another. The promise
 * never rejects: the stores this wraps report their own failures, and one that throws
 * anyway is logged here rather than left unhandled behind a `void`.
 */
export function freshRead(
  key: string,
  store: Readable<unknown>,
  load: () => Promise<void>,
  freshForMs = FRESH_FOR_MS
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const last = answeredAt.get(key);
    if (last !== undefined && Date.now() - last < freshForMs) return Promise.resolve();

    let heard = false;
    const stop = store.subscribe(() => (heard = true));
    // `subscribe` calls back once, synchronously, with the value already held; that is
    // not an answer.
    heard = false;
    // Through a promise constructor, so a `load` that throws before returning one is a
    // rejection like any other rather than an exception out of the caller's click handler.
    inFlight = new Promise<void>((resolve) => resolve(load()))
      .catch((error: unknown) => console.warn(`micaOS Contacts: the ${key} read failed`, error))
      .finally(() => {
        stop();
        if (heard) answeredAt.set(key, Date.now());
        inFlight = null;
      });
    return inFlight;
  };
}
