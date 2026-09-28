// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { LIVE_SHARE_EVENT } from '@mica/shared/contracts/places';
import { subscribeAppEvent } from './appEvents';

/**
 * Whether this phone is sharing its live location right now (MICA-244), for the status-bar
 * indicator — so the player can see it from any app, not only from inside Places.
 *
 * Fed by the server's own `places:live_share` push, sent when a share starts and when it ends
 * (stop, expiry noticed by the server's tick, the sharer's recipients all gone). The shell
 * never imports out of `apps/`, so it does not read the Places store; the push is the one
 * source both sides agree on. The expiry is also timed here, so the icon goes at the stated
 * minute even if the "ended" push is late or lost.
 */
export const liveLocationSharing = writable(false);

let clearTimer: ReturnType<typeof setTimeout> | null = null;

const stopTimer = (): void => {
  if (clearTimer !== null) clearTimeout(clearTimer);
  clearTimer = null;
};

/** Apply one `live_share` payload. Exported for tests. */
export const applyLiveShare = (payload: unknown, at: number = Date.now()): void => {
  stopTimer();
  const data = (payload ?? {}) as { active?: unknown; expires_at?: unknown };
  const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : 0;
  if (data.active !== true || expiresAt <= at) {
    liveLocationSharing.set(false);
    return;
  }
  liveLocationSharing.set(true);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    liveLocationSharing.set(false);
  }, expiresAt - at);
};

// Module scope, so it is permanent: the CEF page never unloads, and a component-scoped
// subscription would miss a share ending while nothing that drew the icon was mounted.
subscribeAppEvent('places', LIVE_SHARE_EVENT, (event) => applyLiveShare(event.payload));
