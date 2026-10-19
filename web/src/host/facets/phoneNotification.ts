// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, type Readable } from 'svelte/store';
import type { SendNotificationOptions } from '../../../../sdk/host/facets';
import type { ToastMessage, ToastType } from '../../../../sdk/vocabulary/shell';
import { registerFacet } from '../../../../sdk/host/current';
import { toast } from '../../shell/state/toast';

/**
 * The shell's toast API as a core app gets it. `find` is left off: it reads any app's toast
 * record by id, and only the ownership check below needs it.
 */
const { find: findToast, ...shellToast } = toast;

/** Bumped per notice, so every id `sendNotification` hands out is new for the session. */
let sent = 0;

/**
 * The types a notice may take. The rest belong to the shell's own helpers, and each one
 * changes how the shell treats the toast, not just how it looks. A `call` interrupts the
 * banner on screen, is never dropped from the queue, and stops the ringtone when it goes,
 * which silences a real call waiting behind it. A `message` or a `contact` looks like
 * something it cannot back up. A core app that needs one uses `toast.showCall` and its
 * siblings.
 */
const NOTICE_TYPES: ReadonlySet<ToastType> = new Set(['info', 'success', 'warning', 'error']);

/**
 * The longest a notice stays on screen, in ms. The shell names no default for a plain
 * toast (`toast.show` falls back to a bare 4.5 s), so this is a ceiling of its own, the
 * length of a contact card's banner. Only one toast shows at a time, and a notice that
 * never expired held every banner behind it until the player swiped it away.
 */
const MAX_NOTICE_MS = 10_000;

/** A duration a notice may have: capped, and `undefined` (the shell's 4.5 s) unless positive. */
const noticeDuration = (ms: unknown): number | undefined =>
  typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_NOTICE_MS) : undefined;

/**
 * The toasts on screen that belong to `appId`, and nobody else's.
 *
 * Republished only when that list changes. The shell's store changes for every app's
 * toast, and an empty list pushed each time would still tell a listener that some other app
 * just notified, and when.
 */
function ownToasts(appId: string): Readable<ToastMessage[]> {
  let last: ToastMessage[] = [];
  return derived(
    toast,
    ($all, set) => {
      const mine = $all.filter((t) => t.app === appId);
      if (mine.length !== last.length || mine.some((t, i) => t !== last[i])) {
        last = mine;
        set(mine);
      }
    },
    last
  );
}

/**
 * OS Service Hook for sending toast notifications and system alerts, for one app.
 *
 * Pinned to `appId` like `storage` and `lifecycle`: `IframeHostServer.ts` replaces whatever
 * id a sandboxed frame sends with its own (`APP_SCOPED_FACETS`). Before, the facet took no
 * app at all. An add-on's notice was filed in the drawer under `'system'`, or under
 * `'messages'` when it passed `type: 'message'`, with its own title and avatar on the row.
 * `toast` streamed every app's toasts to it, message text included, and
 * `dismissNotification` took down any toast whose id it could guess.
 *
 * - `sendNotification` files the toast and its drawer row under `appId`, always. The
 *   options carry no `app`, and none is read from them. It is an `app` arrival, so Do Not
 *   Disturb and the app's own mute hold its banner the way they hold any app's; the drawer
 *   row is written regardless. Its `type` is one of `NOTICE_TYPES`, and anything else is
 *   sent as `info`. It always expires: a `duration` past `MAX_NOTICE_MS` is cut to it, and
 *   zero, a negative or none gets the shell's default. A core app that needs a toast to stay
 *   up uses `toast.show`, which takes its options as given.
 * - `dismissNotification` takes down a toast, on screen or waiting, whose record names
 *   `appId` as its app. An id belonging to another app throws, and the toast stays. An id
 *   that is gone, or never was, has nothing to take down and does nothing.
 * - `toast` subscribes to `appId`'s own toasts only. Its other members are the shell's toast
 *   API, unpinned, because only a core app can reach them. A frame's member table
 *   (`FACET_MEMBERS`) offers `toast` as a store and nothing on it is callable.
 *
 * `appId` is optional only so a caller written before the argument existed still compiles.
 * A core app that names no app has its notices filed under `'system'`. An add-on's are
 * filed under its own id whatever it passes.
 */
export function phoneNotification(appId?: string) {
  const id = (appId ?? 'system').toLowerCase();
  const own = ownToasts(id);
  return {
    sendNotification: (options: SendNotificationOptions) => {
      const type = options.type && NOTICE_TYPES.has(options.type) ? options.type : 'info';
      return toast.show({
        id: `notice:${id}:${++sent}`,
        app: id,
        source: 'app',
        title: options.title,
        message: options.message,
        avatar: options.avatar,
        type,
        duration: noticeDuration(options.duration),
        onClick: options.onClick
      });
    },
    dismissNotification: (toastId: string) => {
      // Ownership is read off the record, never parsed out of the id.
      const found = typeof toastId === 'string' ? findToast(toastId) : undefined;
      if (!found) return;
      if (found.app !== id) {
        throw new Error(`[micaOS] '${id}' may only dismiss its own notifications`);
      }
      toast.dismiss(toastId);
    },
    toast: { ...shellToast, subscribe: own.subscribe }
  };
}

registerFacet('phoneNotification', phoneNotification);
