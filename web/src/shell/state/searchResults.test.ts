import { describe, it, expect } from 'vitest';
import type { Contact } from '@shared/types';
import type { AppManifest } from '../../sdk/manifest';
import type { UIConversation } from '../../services/conversations';
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

const sources = {
  apps: [app('messages', 'Messages'), app('camera', 'Camera'), app('bank', 'Bank')],
  contacts: [contact(1, 'Jim', 'Halpert', '555-0100'), contact(2, 'Pam', 'Beesly', '555-0199')],
  conversations: [
    conversation(10, 'Jim Halpert', 'are you coming?'),
    conversation(11, 'Dwight', 'bears beets')
  ]
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

  it('orders apps first, then contacts, then messages', () => {
    const withEveryKind = {
      ...sources,
      apps: [...sources.apps, app('jim_tracker', 'Jim Tracker')]
    };
    expect(searchEverything('jim', withEveryKind).map((r) => r.kind)).toEqual([
      'app',
      'contact',
      'message'
    ]);
  });

  it('hides an admin-only app from a non-admin', () => {
    const withAdminApp = { ...sources, apps: [app('adminer', 'Adminer', { requiresAdmin: true })] };
    expect(searchEverything('admin', withAdminApp)).toEqual([]);
    expect(searchEverything('admin', withAdminApp, { isAdmin: true })).toHaveLength(1);
  });

  it('caps each group so one crowded group cannot bury another', () => {
    const manyContacts = Array.from({ length: SEARCH_RESULTS_PER_GROUP + 3 }, (_, i) =>
      contact(i + 100, `Jim${i}`, 'Doe', `555-02${i}`)
    );
    const results = searchEverything('jim', { ...sources, contacts: manyContacts });
    expect(results.filter((r) => r.kind === 'contact')).toHaveLength(SEARCH_RESULTS_PER_GROUP);
  });
});
