// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { Contact } from '../types';

/**
 * The smallest complete contract: an owner-scoped table whose entire custom surface is the
 * recently-deleted pair. Everything else Contacts does is generic CRUD, derived from its
 * columns and validated by the write allowlist.
 *
 * `contacts:share` is deliberately absent. It is a raw `onNet` handler rather than a
 * `registerEvent` action — the client's NUI callback has already resolved optimistically, so
 * there is no reply to wait on — and a contract only covers what goes through
 * `ServiceEndpoint`. It keeps its own `sanitizeShare`.
 */
export const contactsContract = defineContract({
  id: 'contacts',
  actions: {
    restore: {
      input: s.object({ id: s.positiveInt() }),
      output: responseType<{ ok: boolean }>()
    },
    getDeleted: {
      input: s.none(),
      output: responseType<Contact[]>()
    }
  }
});
