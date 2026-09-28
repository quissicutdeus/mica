// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';

/**
 * The call's one contracted action. Dialling, answering and hanging up are fire-and-forget
 * `onNet` events (`server/services/Phone.ts`) with nothing to answer; the speaker is not,
 * because the phone must show what the server actually did — it refuses a call that is not
 * connected, and a server whose voice setup cannot carry a speaker (MICA-246).
 *
 * `enabled` is a request. Who hears the call is decided on the server from where the server
 * says everybody is standing; nothing here can name a bystander or a channel.
 */
export const phoneContract = defineContract({
  id: 'phone',
  actions: {
    speaker: {
      input: s.object({ enabled: s.boolean() }),
      output: responseType<{ ok: boolean; enabled: boolean }>()
    }
  }
});
