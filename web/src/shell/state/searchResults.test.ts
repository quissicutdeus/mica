// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import type { Contact, Listing, Mail, MediaItem } from '@mica/shared/types';
import type { AppManifest } from '../../../../sdk/manifest';
import type { UIConversation } from '@mica/sdk';
import { searchEverything, SEARCH_RESULTS_PER_GROUP } from './searchResults';

const app = (id: string, name: string, extra: Partial<AppManifest> = {}): AppManifest =>
  ({ id, name, color: 'bg-indigo-600', icon: null, ...extra }) as AppManifest;

const contact = (id: number, firstname: string, lastname: string, phone: string): Contact =>
  ({ id, citizenid: 'me', firstname, lastname, phone, favorite: false }) as Contact;

const conversation = (id: number, targetName: string, lastMessage: string): UIConversation =>
  ({
    id,
    target: '555',
    targetName,
    lastMessage,
    lastMessageAt: '2026-01-01T00:00:00.000Z',
    unreadCount: 0
  }) as UIConversation;

const mediaRow = (id: number, kind: MediaItem['kind'], alt_text?: string): MediaItem =>
  ({ id, citizenid: 'me', kind, alt_text, status: 'active' }) as MediaItem;

const mailRow = (id: number, sender: string, subject: string, content: string): Mail =>
  ({ id, citizenid: 'me', sender, subject, content, read: false, status: 'active' }) as Mail;

const listing = (id: number, title: string, description: string, price = 100): Listing =>
  ({ id, citizenid: 'me', title, description, price, status: 'active' }) as Listing;

/**
 * Every owning app is listed, because a source is only as visible as its app: a fixture
 * that left `contacts` out would search no contacts at all, which is the rule working,
 * not a result to assert against.
 */
const sources = {
  apps: [
    app('messages', 'Messages'),
    app('camera', 'Camera'),
    app('bank', 'Bank'),
    app('contacts', 'Contacts'),
    app('media', 'Media'),
    app('mail', 'Mail'),
    app('marketplace', 'Snatchr')
  ],
  contacts: [contact(1, 'Jim', 'Halpert', '555-0100'), contact(2, 'Pam', 'Beesly', '555-0199')],
  conversations: [
    conversation(10, 'Jim Halpert', 'are you coming?'),
    conversation(11, 'Dwight', 'bears beets')
  ],
  media: [mediaRow(903, 'location', 'Vespucci Beach'), mediaRow(7, 'photo')],
  mail: [
    mailRow(1, 'Fleeca Bank', 'Statement ready', 'Balance: $15,450'),
    mailRow(2, 'LSPD', 'Traffic citation', 'Citation #90214 registered')
  ],
  listings: [listing(1, 'Dirt Bike', 'Runs great', 4500), listing(2, 'Burner Phone', 'Clean')]
};

describe('searchEverything', () => {
  it('returns nothing for an empty or whitespace-only query', () => {
    expect(searchEverything('', sources)).toEqual([]);
    expect(searchEverything('   ', sources)).toEqual([]);
  });

  it('matches an app by name, case-insensitively', () => {
    const results = searchEverything('cam', sources);
    expect(results).toEqual([
      expect.objectContaining({ kind: 'app', id: 'camera', title: 'Camera' })
    ]);
  });

  it('matches a contact by first name, last name and phone number', () => {
    expect(searchEverything('halpert', sources).map((r) => r.title)).toContain('Jim Halpert');
    expect(searchEverything('0199', sources).map((r) => r.title)).toContain('Pam Beesly');
  });

  it('matches a conversation by its message text as well as the other person', () => {
    const byText = searchEverything('beets', sources);
    expect(byText).toEqual([
      expect.objectContaining({ kind: 'message', conversationId: 11, title: 'Dwight' })
    ]);
    // Narrowed rather than reaching straight for `conversationId`: `SearchResult` is a
    // union, and only the message arm carries one.
    const byName = searchEverything('dwight', sources);
    expect(byName.filter((r) => r.kind === 'message').map((r) => r.conversationId)).toEqual([11]);
  });

  it('orders apps, contacts, messages, media, mail, listings, then app-contributed hits', () => {
    const withEveryKind = {
      ...sources,
      apps: [...sources.apps, app('jim_tracker', 'Jim Tracker'), app('journal', 'Journal')],
      media: [mediaRow(1, 'photo', 'Jim at the beach')],
      mail: [mailRow(9, 'Jim', 'hi', 'hello')],
      listings: [listing(3, "Jim's bike", 'as new')],
      providers: [{ appId: 'journal', search: () => [{ id: 1, title: 'Dear Jim' }] }]
    };
    expect(searchEverything('jim', withEveryKind).map((r) => r.kind)).toEqual([
      'app',
      'contact',
      'message',
      'media',
      'mail',
      'listing',
      'external'
    ]);
  });

  it('matches a gallery row by caption or kind and carries its media id (MICA-248)', () => {
    expect(searchEverything('vespucci', sources)).toEqual([
      expect.objectContaining({
        kind: 'media',
        group: 'media',
        mediaId: 903,
        title: 'Vespucci Beach'
      })
    ]);
    // A row with no caption is titled by its kind, and found by it.
    expect(searchEverything('photo', sources)).toEqual([
      expect.objectContaining({ kind: 'media', mediaId: 7, title: 'Photo' })
    ]);
  });

  it('matches mail by sender, subject and body and carries its mail id', () => {
    expect(searchEverything('90214', sources)).toEqual([
      expect.objectContaining({ kind: 'mail', mailId: 2, title: 'Traffic citation' })
    ]);
    expect(searchEverything('fleeca', sources).map((r) => r.kind)).toEqual(['mail']);
  });

  it('matches a listing by title or description, and shows its price', () => {
    expect(searchEverything('runs great', sources)).toEqual([
      expect.objectContaining({ kind: 'listing', listingId: 1, subtitle: '4500 · Runs great' })
    ]);
  });

  it('contributes nothing from a source whose app is hidden or not installed', () => {
    // Mail is admin-only on this phone; Snatchr is not installed at all.
    const locked = {
      ...sources,
      apps: sources.apps
        .filter((a) => a.id !== 'marketplace')
        .map((a) => (a.id === 'mail' ? app('mail', 'Mail', { requiresAdmin: true }) : a))
    };
    expect(searchEverything('fleeca', locked)).toEqual([]);
    expect(searchEverything('fleeca', locked, { isAdmin: true })).toHaveLength(1);
    expect(searchEverything('dirt bike', locked)).toEqual([]);
    expect(searchEverything('dirt bike', sources)).toHaveLength(1);
  });

  it('gates an app-contributed provider on its app, caps it, and heads it by the app', () => {
    const hits = Array.from({ length: SEARCH_RESULTS_PER_GROUP + 2 }, (_, i) => ({
      id: i,
      title: `Entry ${i}`,
      props: { entryId: i }
    }));
    const provider = { appId: 'journal', search: () => hits };

    // Not installed: the provider is never even asked.
    expect(searchEverything('entry', { ...sources, providers: [provider] })).toEqual([]);

    const installed = { ...sources, apps: [...sources.apps, app('journal', 'Journal')] };
    const results = searchEverything('entry', { ...installed, providers: [provider] });
    expect(results).toHaveLength(SEARCH_RESULTS_PER_GROUP);
    expect(results[0]).toEqual(
      expect.objectContaining({
        kind: 'external',
        group: 'app:journal',
        appId: 'journal',
        props: { entryId: 0 }
      })
    );
  });

  it('hides an admin-only app from a non-admin', () => {
    const withAdminApp = { ...sources, apps: [app('adminer', 'Adminer', { requiresAdmin: true })] };
    expect(searchEverything('admin', withAdminApp)).toEqual([]);
    expect(searchEverything('admin', withAdminApp, { isAdmin: true })).toHaveLength(1);
  });

  it('hides an app whose required capability this server does not have', () => {
    // Search is a way *into* an app, so listing one the launcher refuses to draw is the
    // same broken promise as the icon, one tap earlier.
    const withMoneyApp = { ...sources, apps: [app('hodlr', 'Hodlr', { requires: ['money'] })] };

    expect(searchEverything('hodlr', withMoneyApp)).toEqual([]);
    expect(searchEverything('hodlr', withMoneyApp, { capabilities: { money: false } })).toEqual([]);
    expect(searchEverything('hodlr', withMoneyApp, { capabilities: { money: true } })).toHaveLength(
      1
    );
  });

  it('hides an app the owner disabled, and its own contacts group with it (MICA-234)', () => {
    expect(searchEverything('cam', sources, { disabledAppIds: new Set(['camera']) })).toEqual([]);
    // '555-0100' is Jim Halpert's phone number and matches nothing else in `sources`, so
    // this isolates the contacts group from the 'Jim Halpert' conversation title above it.
    expect(
      searchEverything('555-0100', sources, { disabledAppIds: new Set(['contacts']) })
    ).toEqual([]);
    expect(
      searchEverything('555-0100', sources, { disabledAppIds: new Set(['camera']) })
    ).toHaveLength(1);
  });

  it('lists on the tablet only what its launcher would draw (MICA-260)', () => {
    const both = app('admin', 'Admin', { devices: ['phone', 'tablet'] });
    const withDevices = { ...sources, apps: [app('camera', 'Camera'), both] };
    expect(searchEverything('camera', withDevices, { device: 'tablet' })).toEqual([]);
    expect(searchEverything('admin', withDevices, { device: 'tablet' })).toHaveLength(1);
    expect(searchEverything('camera', withDevices)).toHaveLength(1);
  });

  it('caps each group so one crowded group cannot bury another', () => {
    const manyContacts = Array.from({ length: SEARCH_RESULTS_PER_GROUP + 3 }, (_, i) =>
      contact(i + 100, `Jim${i}`, 'Doe', `555-02${i}`)
    );
    const results = searchEverything('jim', { ...sources, contacts: manyContacts });
    expect(results.filter((r) => r.kind === 'contact')).toHaveLength(SEARCH_RESULTS_PER_GROUP);
  });
});
