// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import { call, callOr } from '../nui/call';
import { contactsContract } from '@mica/shared/contracts/contacts';
import { createCrudStore } from '../../../sdk/createCrudStore';
import type { Contact } from '@mica/shared/types';

/**
 * The one rule, applied to a create, an update and a share alike.
 *
 * Sharing says so in its own words: the message reaches the player as a toast, and
 * "required to share contact" is the difference between a form they can fix and an
 * action that will not go through.
 */
const requireNameAndPhone = (draft: Partial<Contact>, forSharing = false) => {
  if (draft.firstname?.trim() && draft.phone?.trim()) return;
  throw new Error(
    forSharing
      ? 'First name and phone number are required to share contact.'
      : 'First name and phone number are required.'
  );
};

const store = createCrudStore<
  Contact,
  Omit<Contact, 'id' | 'citizenid' | 'created_at' | 'updated_at'>
>(
  'Contacts',
  {
    list: 'getContacts',
    create: 'createContact',
    update: 'updateContact',
    remove: 'deleteContact'
  },
  { validate: requireNameAndPhone }
);

export const contacts = {
  ...store,

  /**
   * Offer a contact to another player. Not a CRUD write — nothing enters this list.
   */
  share: async (payload: Partial<Contact> & { name?: string; phone: string }) => {
    const firstname = payload.firstname || payload.name?.split(' ')[0];
    requireNameAndPhone({ firstname, phone: payload.phone }, true);
    await fetchNui('shareContact', payload);
  },

  /**
   * The "Recently Deleted" list (MICA-75-wiring) — every soft-deleted contact still
   * within the restore window. Not part of the cached `store` above: this is a screen
   * visited rarely enough that a fresh read each time is the right cost, not a second
   * list to keep in sync with the first.
   *
   * Rejects on failure, and on a reply that is not a list. It answered `[]` instead, which is
   * the "Nothing recently deleted" a player is shown for a contact they deleted a minute ago
   * and can still restore.
   */
  getDeleted: async (): Promise<Contact[]> => {
    const rows: unknown = await call(contactsContract, 'getDeleted', undefined);
    if (!Array.isArray(rows)) throw new Error('contacts:getDeleted answered without a list');
    return rows as Contact[];
  },

  /**
   * Undo a delete. Refreshes the main list on success so the restored contact reappears
   * in it without waiting for the next foreground reload.
   */
  restore: async (id: number): Promise<boolean> => {
    const { ok } = await callOr(contactsContract, 'restore', { id }, { ok: false });
    if (ok) await store.load();
    return ok;
  }
};

export const favoriteContacts = derived(contacts, ($contacts) =>
  $contacts.filter((c) => c.favorite)
);

/** Digits only, so `555-0199` and `5550199` are one number. */
const digitsOf = (phone: string): string => phone.replace(/\D/g, '');

/**
 * The address book keyed by number, rebuilt once per change to the list (MICA-374).
 *
 * Two lookups ran a `find` over every contact per call: the inbox once per conversation row
 * on every message, read or rename, and the ringtone lookup once per ring, stripping every
 * contact's number as it went. Both read this instead.
 *
 * **Two keys, because the two callers match differently, and each keeps its own rule.**
 * `byPhone` is the number exactly as saved — what a thread's label has always matched on.
 * `byDigits` is the number with everything but digits stripped — what a ringtone has always
 * matched on, since a caller arrives as `5550199` and a contact is saved as `555-0199`. The
 * first contact listed wins either key, as `find` did. A contact with no digits at all is
 * left out of `byDigits`, so an empty caller id cannot match one, and a row with no number
 * at all is left out of both.
 */
export const contactIndex = derived(contacts, ($contacts) => {
  const byPhone = new Map<string, Contact>();
  const byDigits = new Map<string, Contact>();
  for (const contact of $contacts) {
    // A row with no number is skipped rather than read. A throw here would be a throw inside
    // a store subscriber, which leaves svelte/store's shared queue mid-flush and stops every
    // store in the phone from updating — far worse than one unlabelled contact.
    if (typeof contact.phone !== 'string') continue;
    if (!byPhone.has(contact.phone)) byPhone.set(contact.phone, contact);
    const digits = digitsOf(contact.phone);
    if (digits && !byDigits.has(digits)) byDigits.set(digits, contact);
  }
  return { byPhone, byDigits };
});

// Held subscribed for the life of the module, so the index is built once per change to the
// list and every `get(contactIndex)` reads that copy. Without a subscriber, a derived store
// recomputes on each `get()` — a ring or a page read would rebuild both maps every time,
// which is the per-call walk this exists to remove. The list's own store has no start
// function, so subscribing loads nothing.
contactIndex.subscribe(() => {});
