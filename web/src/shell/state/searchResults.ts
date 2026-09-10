// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Contact, Listing, Mail } from '@mica/shared/types';
import type { AppManifest } from '../../../../sdk/manifest';
import type { ProvidedHit, UIConversation } from '@mica/sdk';
import { manifestVisible, type CapabilitySet } from '../../lib/phone/appVisibility';
import { DEFAULT_DEVICE, type DeviceId } from '@mica/shared/devices';
import { matchesMedia, type SearchableMedia } from '../../services/media';
import { matchesMail } from '../../services/mail';
import { matchesListing } from '../../services/marketplace';

/**
 * How many hits each group contributes at most.
 *
 * The cap is per group rather than overall on purpose: a player with forty contacts named
 * some variation of "Jim" would otherwise push every app and every conversation off the
 * end of a single global limit, and the app row is the one a home-screen search is most
 * often reaching for.
 */
export const SEARCH_RESULTS_PER_GROUP = 5;

/**
 * The section a result is listed under. The fixed ones are the phone's own sources; an
 * app-contributed result (MICA-248) is grouped under its app, `app:<id>`, so two add-ons
 * never share a heading.
 */
export type SearchGroup =
  'apps' | 'contacts' | 'messages' | 'media' | 'mail' | 'listings' | `app:${string}`;

interface SearchResultBase {
  /** Unique within a result list, so `{#each}` has a stable key across keystrokes. */
  key: string;
  group: SearchGroup;
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

/** A gallery row; opens the Media app on it via its `initialPhotoId` deep link. */
export interface MediaSearchResult extends SearchResultBase {
  kind: 'media';
  mediaId: number;
}

/** A mail message; opens the Mail app on it via its `mailId` deep link. */
export interface MailSearchResult extends SearchResultBase {
  kind: 'mail';
  mailId: number;
}

/**
 * A Snatchr listing; opens the app on that listing via its `listingId` deep link
 * (MICA-286, which is the day the app grew one).
 */
export interface ListingSearchResult extends SearchResultBase {
  kind: 'listing';
  listingId: number;
}

/**
 * A hit an app contributed for itself (see `SearchProvider`). Core cannot name an add-on
 * (`sdk/coreBoundary.test.ts`), so this is the only way a `core: false` app's rows reach
 * the home search: the shell opens `appId` with whatever `props` the provider handed back.
 */
export interface ExternalSearchResult extends SearchResultBase {
  kind: 'external';
  appId: string;
  props: Record<string, unknown>;
}

export type SearchResult =
  | AppSearchResult
  | ContactSearchResult
  | MessageSearchResult
  | MediaSearchResult
  | MailSearchResult
  | ListingSearchResult
  | ExternalSearchResult;

/**
 * One hit from a `SearchProvider`; `id` need only be unique within that provider.
 *
 * The SDK owns this shape (MICA-286): it is the return type of the `search` an app writes
 * for `useSearchProvider`, so it is part of the published contract rather than the shell's
 * private vocabulary. Re-exported here because every consumer of a result in this file
 * reaches for it beside `SearchProvider`.
 */
export type { ProvidedHit };

/**
 * An app's own search, contributed to the home screen.
 *
 * The shell knows the app only by `appId`, checks that app's visibility exactly as it
 * does for the built-in sources, caps the hits per provider, and never sees the rows the
 * provider searched. `search` receives the trimmed, lower-cased query.
 *
 * **Synchronous, and it has to stay that way** — this function is called during a render
 * that is already deriving the result list. An app that cannot answer synchronously is not
 * a provider: `shell/state/searchProviders.ts` is what turns a sandboxed add-on's
 * asynchronous answer into one of these.
 */
export interface SearchProvider {
  appId: string;
  search: (needle: string) => ProvidedHit[];
}

export interface SearchSources {
  apps: AppManifest[];
  contacts: Contact[];
  conversations: UIConversation[];
  media?: SearchableMedia[];
  mail?: Mail[];
  listings?: Listing[];
  providers?: SearchProvider[];
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

const mediaTitle = (item: SearchableMedia): string =>
  item.alt_text?.trim() || item.kind.charAt(0).toUpperCase() + item.kind.slice(1);

/**
 * Everything on the phone that matches `query`, in the order a player expects to find it:
 * apps, then contacts, then conversations, then the gallery, mail, Snatchr listings, and
 * last whatever an app contributed for itself (MICA-248).
 *
 * That order is fixed rather than relevance-scored. An app name is the shortest, most
 * predictable thing to type at a home screen and is nearly always what a one-word query
 * means; ranking a contact above it because the substring happened to start at index 0
 * would make the common case feel random.
 *
 * **A source is only as visible as the app that owns it.** Every row group is gated on its
 * app's manifest passing `manifestVisible` — the same rule the launcher draws by — and on
 * that app being in `sources.apps` at all, so an uninstalled add-on, an admin-only app, or
 * one this device's launcher does not draw contributes nothing. Search is a way *into* an
 * app; a result for an app the player cannot open is a dead tap.
 *
 * Conversations are searched by the other person's name and by `lastMessage` only — that
 * is the whole of the message text the conversation list actually holds. Full-history
 * search would need every thread fetched from the server up front, which is a different
 * (and much more expensive) feature than a live home-screen filter. The same holds for
 * every other source: only what the client-side caches already hold is searched.
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

  const facts = { isAdmin, capabilities, device };
  const visible = (manifest: AppManifest) => manifestVisible(manifest, facts);
  const ownerVisible = (appId: string): boolean =>
    sources.apps.some((app) => app.id === appId && visible(app));

  const apps: AppSearchResult[] = sources.apps
    .filter((app) => visible(app) && matches(needle, app.name))
    .slice(0, SEARCH_RESULTS_PER_GROUP)
    .map((manifest) => ({
      kind: 'app',
      group: 'apps',
      key: `app:${manifest.id}`,
      id: manifest.id,
      title: manifest.name,
      subtitle: manifest.description ?? 'App',
      manifest
    }));

  const contacts: ContactSearchResult[] = !ownerVisible('contacts')
    ? []
    : sources.contacts
        .filter((c) => matches(needle, c.firstname, c.lastname, c.phone))
        .slice(0, SEARCH_RESULTS_PER_GROUP)
        .map((contact) => ({
          kind: 'contact',
          group: 'contacts',
          key: `contact:${contact.id}`,
          title: contactName(contact),
          subtitle: contact.phone,
          contact
        }));

  const messages: MessageSearchResult[] = !ownerVisible('messages')
    ? []
    : sources.conversations
        .filter((c) => matches(needle, c.targetName, c.lastMessage))
        .slice(0, SEARCH_RESULTS_PER_GROUP)
        .map((conversation) => ({
          kind: 'message',
          group: 'messages',
          key: `message:${conversation.id}`,
          conversationId: conversation.id,
          title: conversation.targetName,
          subtitle: conversation.lastMessage
        }));

  const media: MediaSearchResult[] = !ownerVisible('media')
    ? []
    : (sources.media ?? [])
        .filter((item) => matchesMedia(item, needle))
        .slice(0, SEARCH_RESULTS_PER_GROUP)
        .map((item) => ({
          kind: 'media',
          group: 'media',
          key: `media:${item.id}`,
          mediaId: item.id,
          title: mediaTitle(item),
          subtitle: item.kind
        }));

  const mail: MailSearchResult[] = !ownerVisible('mail')
    ? []
    : (sources.mail ?? [])
        .filter((message) => matchesMail(message, needle))
        .slice(0, SEARCH_RESULTS_PER_GROUP)
        .map((message) => ({
          kind: 'mail',
          group: 'mail',
          key: `mail:${message.id}`,
          mailId: message.id,
          title: message.subject,
          subtitle: message.sender
        }));

  const listings: ListingSearchResult[] = !ownerVisible('marketplace')
    ? []
    : (sources.listings ?? [])
        .filter((listing) => matchesListing(listing, needle))
        .slice(0, SEARCH_RESULTS_PER_GROUP)
        .map((listing) => ({
          kind: 'listing',
          group: 'listings',
          key: `listing:${listing.id}`,
          listingId: listing.id,
          title: listing.title,
          subtitle: `${listing.price} · ${listing.description}`
        }));

  const external: ExternalSearchResult[] = (sources.providers ?? [])
    .filter((provider) => ownerVisible(provider.appId))
    .flatMap((provider) =>
      provider
        .search(needle)
        .slice(0, SEARCH_RESULTS_PER_GROUP)
        .map((hit) => ({
          kind: 'external' as const,
          group: `app:${provider.appId}` as const,
          key: `app:${provider.appId}:${hit.id}`,
          appId: provider.appId,
          props: hit.props ?? {},
          title: hit.title,
          subtitle: hit.subtitle ?? ''
        }))
    );

  return [...apps, ...contacts, ...messages, ...media, ...mail, ...listings, ...external];
}
