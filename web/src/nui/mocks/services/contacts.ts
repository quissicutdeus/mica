// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseDefaultContacts } from '@mica/shared/ownerConfig';
import type { Contact } from '@mica/shared/types';
import { mockContacts } from '../data';
import { defineMockCrud } from '../defineMockCrud';
import type { MockHandler } from '../registry';
import { delay, ownerConfigRaw, bluetoothNearbyCount } from '../shared';

/**
 * Default contacts an owner seeds (MICA-234). The real server seeds rows into the
 * `mica_contacts` table; this mock has no server to seed, so the entries are appended to
 * `mockContacts` directly, at ids well past every other fixture's range (the highest,
 * `deletedContact`, sits at 9999) so a real one is never overwritten.
 */
const OWNER_DEFAULT_CONTACT_ID_BASE = 20000;
parseDefaultContacts(
  ownerConfigRaw('mica_default_contacts', String(import.meta.env.VITE_MICA_DEFAULT_CONTACTS ?? ''))
).value.forEach((entry, index) => {
  const now = new Date().toISOString();
  mockContacts.push({
    id: OWNER_DEFAULT_CONTACT_ID_BASE + index,
    citizenid: `owner-default-${index}`,
    firstname: entry.name,
    lastname: '',
    phone: entry.number,
    favorite: false,
    status: 'active',
    created_at: now,
    updated_at: now
  });
});

export const mocks: Record<string, MockHandler> = {
  // Contacts
  ...defineMockCrud<Contact>(
    mockContacts,
    {
      list: 'getContacts',
      create: 'createContact',
      update: 'updateContact',
      remove: 'deleteContact'
    },
    // MICA-75-wiring: the real server never hard-deletes a contact (`Repository.
    // delete` only ever moves `status` to `'deleted'`) — matching that here is what
    // makes a deleted-then-restored contact a real round trip in the mock, not one
    // that only works against a live server.
    { remove: 'soft', visible: (c) => c.status !== 'deleted', defaults: { status: 'active' } }
  ),
  /**
   * The real client resolves this NUI callback immediately and pushes the outcome
   * asynchronously as a toast — mirrored here via the same `appEvent` message the real
   * server push travels over, so the round trip is exercised rather than faked.
   */
  shareContact: async () => {
    const count = bluetoothNearbyCount;
    if (typeof window !== 'undefined') {
      delay(150).then(() => {
        window.postMessage(
          {
            action: 'appEvent',
            data: {
              app: 'contacts',
              event: 'share_result',
              payload: { count },
              at: Date.now(),
              notify: {
                title: count > 0 ? 'Contact shared' : 'Nobody nearby',
                message:
                  count > 0
                    ? `Shared with ${count} nearby ${count === 1 ? 'phone' : 'phones'}.`
                    : 'No Bluetooth-visible players are in range.'
              }
            }
          },
          '*'
        );
      });
    }
    return { ok: true };
  },
  'contacts:getDeleted': () => mockContacts.filter((c) => c.status === 'deleted'),
  'contacts:restore': (data: { id?: number }) => {
    const contact = mockContacts.find((c) => c.id === data?.id && c.status === 'deleted');
    if (!contact) return { ok: false };
    contact.status = 'active';
    return { ok: true };
  }
};
