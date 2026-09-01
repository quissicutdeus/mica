// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { contacts as contactsService, favoriteContacts } from '../../services/contacts';

/**
 * OS Service Hook for accessing address book contacts and sharing contacts.
 */
export function contacts() {
  return {
    contactsStore: contactsService,
    favoriteContacts,
    addContact: (
      firstname: string,
      phone: string,
      lastname?: string,
      avatar?: string,
      favorite?: boolean
    ) => {
      return contactsService.add({
        firstname,
        lastname: lastname || '',
        phone,
        avatar,
        favorite: favorite ?? false
      });
    },
    shareContact: (firstname: string, phone: string, lastname?: string) => {
      return contactsService.share({ firstname, lastname: lastname || '', phone });
    },
    /** The "Recently Deleted" list (MICA-75-wiring) — see `services/contacts.ts`. */
    getDeletedContacts: () => contactsService.getDeleted(),
    restoreContact: (id: number) => contactsService.restore(id)
  };
}

registerFacet('contacts', contacts);
