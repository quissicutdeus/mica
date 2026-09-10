// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get } from 'svelte/store';
import { call } from '../nui/call';
import { mailContract } from '@mica/shared/contracts/mail';
import { createCrudStore } from '../../../sdk/createCrudStore';
import type { Mail } from '@mica/shared/types';

// `service` set, so both actions ride the generic service action by their contracted
// names and need no row in `shared/routes.ts` (MICA-213).
const store = createCrudStore<Mail>(
  'Mail',
  { list: 'getMail', remove: 'deleteMail' },
  { service: 'mail' }
);

/**
 * Whether a message answers a home-search query (MICA-248): sender, subject or body,
 * for anything the inbox or archive still shows. `needle` is trimmed and lower-cased by
 * the caller — `searchEverything` owns the shared ranking rule, this is Mail's half.
 */
export const matchesMail = (mail: Mail, needle: string): boolean =>
  (mail.status ?? 'active') !== 'deleted' &&
  [mail.sender, mail.subject, mail.content].some((value) => value?.toLowerCase().includes(needle));

export const mailStore = {
  ...store,

  /** The cached messages matching `query`, case-insensitively; never fetches. */
  search: (query: string): Mail[] => {
    const needle = query.trim().toLowerCase();
    return needle ? get(store).filter((mail) => matchesMail(mail, needle)) : [];
  },

  /**
   * Mail is read-only from the phone's side apart from these two flags, so they are the
   * app's own verbs rather than a generic update. Both wait for the server before the
   * list changes: they used to patch first, which meant a failed archive left the
   * message hidden until the next reload put it back.
   */
  markAsRead: async (id: number) => {
    await call(mailContract, 'markAsRead', { id });
    store.patch(id, { read: true });
  },

  archive: async (id: number, archive: boolean = true) => {
    await call(mailContract, 'archiveMail', { id, archive });
    store.patch(id, { status: archive ? 'archived' : 'active' });
  },

  /** Arrives by push, so there is nothing to tell the server. */
  addReceivedMail: (incoming: Mail) => {
    const current = get(store);
    const clashes = incoming.id && current.some((m) => m.id === incoming.id);
    const id = clashes || !incoming.id ? Date.now() : incoming.id;
    store.set([{ ...incoming, id, status: incoming.status || 'active' }, ...current]);
  }
};

export const unreadMailCount = derived(
  mailStore,
  ($mailStore) => $mailStore.filter((m) => !m.read && m.status === 'active').length
);
