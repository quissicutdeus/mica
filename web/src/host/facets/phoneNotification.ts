// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, type Readable } from 'svelte/store';
import type { SendNotificationOptions } from '../../../../sdk/host/facets';
import type { ToastMessage } from '../../../../sdk/vocabulary/shell';
import { registerFacet } from '../../../../sdk/host/current';
import { toast } from '../../shell/state/toast';

/** Bumped per notice, so every id `sendNotification` hands out is new for the session. */
let sent = 0;

/**
 * The id prefix of every notice sent for `appId`. App ids match `[a-z][a-z0-9_]*`
 * (`sdk/manifest.ts`), so no id can contain the `:` that ends this, and one app's prefix
 * is never the start of another's.
 */
const noticePrefix = (appId: string) => `notice:${appId}:`;

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
 *   options carry no `app`, and none is read from them.
 * - `dismissNotification` takes down only a notice that `sendNotification` sent for
 *   `appId`, or a toast on screen that names `appId` as its app. Any other id throws, and
 *   the toast stays.
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
  const prefix = noticePrefix(id);
  const own = ownToasts(id);
  return {
    sendNotification: (options: SendNotificationOptions) => {
      return toast.show({
        id: `${prefix}${++sent}`,
        app: id,
        title: options.title,
        message: options.message,
        avatar: options.avatar,
        type: options.type || 'info',
        duration: options.duration,
        onClick: options.onClick
      });
    },
    dismissNotification: (toastId: string) => {
      const mine =
        typeof toastId === 'string' &&
        (toastId.startsWith(prefix) || get(own).some((t) => t.id === toastId));
      if (!mine) {
        throw new Error(`[micaOS] '${id}' may only dismiss its own notifications`);
      }
      toast.dismiss(toastId);
    },
    toast: { ...toast, subscribe: own.subscribe }
  };
}

registerFacet('phoneNotification', phoneNotification);
