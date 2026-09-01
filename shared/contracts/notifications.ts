// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { NotificationItem } from '../types';

/**
 * The shade. Every read and write is a named action, so no generic one is registered and all
 * seven live here.
 *
 * The three list actions take an `ids` array, and it is bounded — which the hand-written
 * version was not. It read `Array.isArray(raw) ? raw.map(requirePositiveInt) : []`, so a
 * million-element array was a million coercions and then an `IN (...)` clause with a million
 * placeholders, for one rate-limited request. The shade shows a few dozen rows; two hundred is
 * far past any honest bulk select and still nothing a database notices.
 *
 * An unparseable `ids` used to become `[]`, which is a no-op reported as success. It is a
 * refusal now: "mark these read" and "mark nothing read" are different requests, and a client
 * that meant the first should not be told the second worked.
 */
const ids = s.array(s.positiveInt(), { max: 200 });

export const notificationsContract = defineContract({
  id: 'notifications',
  actions: {
    getShadeNotifications: { input: s.none(), output: responseType<NotificationItem[]>() },
    getNotificationHistory: { input: s.none(), output: responseType<NotificationItem[]>() },
    getUnreadCounts: { input: s.none(), output: responseType<Record<string, number>>() },

    markAsRead: { input: s.object({ ids }), output: responseType<boolean>() },
    clearNotifications: { input: s.object({ ids }), output: responseType<boolean>() },
    restoreNotifications: { input: s.object({ ids }), output: responseType<boolean>() },

    /**
     * Clear everything, or everything one app raised.
     *
     * `appId` is optional and reaches no SQL identifier — it is compared as a value against
     * the `app` column, whose declared length is 32.
     */
    clearAllNotifications: {
      input: s.object({ appId: s.string({ min: 1, max: 32 }).optional() }),
      output: responseType<boolean>()
    }
  }
});
