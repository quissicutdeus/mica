// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { DarkchatMessage } from '../types';

/**
 * Messages in a Dark Chat channel (MICA-254).
 *
 * Here rather than beside its `defineService`, for the reason `glimpse_comments` is: this id
 * is not the add-on's own, so naming it in core names no app. The channels contract is not
 * here, for the same rule read the other way — see `server/services/Darkchat.ts`.
 *
 * Both axes of the service are `members`, so no generic action is registered at all. Each
 * action below names its channel, and the handler checks live membership before anything
 * else (§2.9): a `channel_id` is a number in a payload and proves nothing about who sent it.
 *
 * There is no edit and no delete. A message leaves when its window passes
 * (`mica_darkchat_retention`), or when staff moderate it. A line from the `PostToDarkChat`
 * export has no action here, so no player can reach that path.
 */
export const darkchatMessagesContract = defineContract({
  id: 'darkchat_messages',
  actions: {
    /**
     * A channel's messages inside the retention window, newest first, keyset-paged on
     * `id DESC`. A row past the window is never answered, swept or not.
     */
    list: {
      input: s.object({
        channel_id: s.positiveInt(),
        cursor: s.positiveInt().nullable().optional(),
        limit: s.positiveInt().optional()
      }),
      output: responseType<{ rows: DarkchatMessage[]; nextCursor: number | null }>()
    },

    /** Post to a channel under the caller's alias in it. */
    send: {
      input: s.object({
        channel_id: s.positiveInt(),
        /** The longest body whose sealed form the column holds; Messages' rule. */
        body: s.string({ min: 1, max: 500 })
      }),
      output: responseType<DarkchatMessage>()
    }
  }
});
