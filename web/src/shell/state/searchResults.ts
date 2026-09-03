// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Contact } from '@gos/shared/types';
import type { AppManifest } from '../../../../sdk/manifest';
import type { UIConversation } from '@gos/sdk';
import { manifestVisible, type CapabilitySet } from '../../lib/phone/appVisibility';
import { DEFAULT_DEVICE, type DeviceId } from '@gos/shared/devices';

/**
 * How many hits each group contributes at most.
 *
 * The cap is per group rather than overall on purpose: a player with forty contacts named
 * some variation of "Jim" would otherwise push every app and every conversation off the
 * end of a single global limit, and the app row is the one a home-screen search is most
 * often reaching for.
 */
export const SEARCH_RESULTS_PER_GROUP = 5;

interface SearchResultBase {
  /** Unique within a result list, so `{#each}` has a stable key across keystrokes. */
  key: string;
  title: string;
  subtitle: string;
}

export interface AppSearchResult extends SearchResultBase {
  kind: 'app';
  id: string;
  manifest: AppManifest;
}

export interface ContactSearchResult extends SearchResultBase {
  kind: 'contact';
  contact: Contact;
}

export interface MessageSearchResult extends SearchResultBase {
  kind: 'message';
  conversationId: number;
}

export type SearchResult = AppSearchResult | ContactSearchResult | MessageSearchResult;

export interface SearchSources {
  apps: AppManifest[];
  contacts: Contact[];
  conversations: UIConversation[];
}

/**
 * The two facts that decide whether an app is on this phone at all.
 *
 * Both default to the least-privileged answer, so a caller that forgets one gets a search
 * that hides too much rather than one that surfaces an app the launcher does not draw —
 * search is a way *into* an app, so listing a hidden one is the same broken promise as the
 * icon, one tap earlier.
 */
export interface SearchOptions {
  isAdmin?: boolean;
  capabilities?: CapabilitySet;
  /** The device on screen (MICA-260); search lists what its launcher would draw. */
  device?: DeviceId;
}

const NOTHING_SATISFIED: CapabilitySet = {};

const matches = (needle: string, ...haystack: (string | undefined)[]): boolean =>
  haystack.some((value) => value?.toLowerCase().includes(needle));

const contactName = (c: Contact) => [c.firstname, c.lastname].filter(Boolean).join(' ');

/**
 * Everything on the phone that matches `query`, in the order a player expects to find it:
 * apps, then contacts, then conversations.
 *
 * That order is fixed rather than relevance-scored. An app name is the shortest, most
 * predictable thing to type at a home screen and is nearly always what a one-word query
 * means; ranking a contact above it because the substring happened to start at index 0
 * would make the common case feel random.
 *
 * Conversations are searched by the other person's name and by `lastMessage` only — that
 * is the whole of the message text the conversation list actually holds. Full-history
 * search would need every thread fetched from the server up front, which is a different
 * (and much more expensive) feature than a live home-screen filter.
 *
 * Pure, and takes its data as arguments rather than reading the stores itself, so the
 * ranking is testable without mounting the phone or standing up four services.
 */
export function searchEverything(
  query: string,
  sources: SearchSources,
  { isAdmin = false, capabilities = NOTHING_SATISFIED, device = DEFAULT_DEVICE }: SearchOptions = {}
): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const apps: AppSearchResult[] = sources.apps
    .filter(
      (app) => manifestVisible(app, { isAdmin, capabilities, device }) && matches(needle, app.name)
    )
    .slice(0, SEARCH_RESULTS_PER_GROUP)
    .map((manifest) => ({
      kind: 'app',
      key: `app:${manifest.id}`,
      id: manifest.id,
      title: manifest.name,
      subtitle: manifest.description ?? 'App',
      manifest
    }));

  const contacts: ContactSearchResult[] = sources.contacts
    .filter((c) => matches(needle, c.firstname, c.lastname, c.phone))
    .slice(0, SEARCH_RESULTS_PER_GROUP)
    .map((contact) => ({
      kind: 'contact',
      key: `contact:${contact.id}`,
      title: contactName(contact),
      subtitle: contact.phone,
      contact
    }));

  const messages: MessageSearchResult[] = sources.conversations
    .filter((c) => matches(needle, c.targetName, c.lastMessage))
    .slice(0, SEARCH_RESULTS_PER_GROUP)
    .map((conversation) => ({
      kind: 'message',
      key: `message:${conversation.id}`,
      conversationId: conversation.id,
      title: conversation.targetName,
      subtitle: conversation.lastMessage
    }));

  return [...apps, ...contacts, ...messages];
}
