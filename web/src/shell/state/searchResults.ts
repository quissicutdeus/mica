import type { Contact } from '@shared/types';
import type { AppManifest } from '../../sdk/manifest';
import type { UIConversation } from '../../services/conversations';

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

export interface SearchOptions {
  isAdmin?: boolean;
}

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
  { isAdmin = false }: SearchOptions = {}
): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const apps: AppSearchResult[] = sources.apps
    .filter((app) => (!app.requiresAdmin || isAdmin) && matches(needle, app.name))
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
