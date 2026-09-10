// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { shellContract } from '@mica/shared/contracts/shell';
import { ownerConfig } from '../lib/ownerConfig';

/**
 * Where this server says its source lives (MICA-192, AGPL §13).
 *
 * §13's obligation belongs to the operator, not to this project: a player connecting to a
 * server running a modified copy is a remote user, and is entitled to *that server's*
 * source. So the answer has to come from the server rather than from a constant compiled
 * into the phone — a fork whose phone points at this repository is telling its players
 * something false while looking compliant, and naming somebody else as the author of
 * changes they did not write.
 *
 * Its own service rather than an action on `Capabilities.ts`, which shares the `shell`
 * scope: that file answers what a server can *do*, and this is not a capability. Both
 * disable every generic CRUD action — there is no table here, and a registered generic
 * action is reachable whether or not a route points at it (`reachability.test.ts`).
 *
 * Read per call rather than cached at boot. An operator can `set` a convar on a running
 * server, and the cost of being right about it is one string read.
 */

const CONVAR = 'mica_source_url';

/** Upstream, and the honest answer for the servers that have not modified anything. */
const DEFAULT_SOURCE_URL = 'https://github.com/quissicutdeus/mica';

/**
 * `https://` and nothing else.
 *
 * The phone never navigates to this — AGENTS.md §6 forbids it, and the About pane copies
 * the string to the clipboard instead — so this is not stopping a `javascript:` URL from
 * being followed. It is stopping the phone from displaying something that is not an
 * address as though it were one, and a §13 offer a player cannot act on is not an offer.
 * A malformed value falls back rather than throwing: an operator's typo should not take
 * the licence notice off the screen.
 */
const isDisplayableUrl = (value: string): boolean => /^https:\/\/[^\s/$.?#][^\s]*$/i.test(value);

export const sourceUrl = (): string => {
  const configured = GetConvar(CONVAR, DEFAULT_SOURCE_URL).trim();
  if (configured === DEFAULT_SOURCE_URL) return configured;

  if (!isDisplayableUrl(configured)) {
    console.warn(
      `[micaOS] ${CONVAR} is '${configured}', which is not an https:// address. Falling back ` +
        `to ${DEFAULT_SOURCE_URL}. If you run a modified copy, AGPL section 13 asks you to ` +
        'point this at your own source.'
    );
    return DEFAULT_SOURCE_URL;
  }
  return configured;
};

const app = new ServiceEndpoint<never, typeof shellContract>('shell', null, {
  contract: shellContract,
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

// No payload is read. The answer is a property of the server, identical for every caller,
// so there is nothing here for §2.9 to sanitize and nothing a client could steer.
app.registerEvent('sourceUrl', async () => ({ url: sourceUrl() }));

/**
 * The owner's default language for the phone (MICA-61), from the `mica_locale` convar.
 *
 * A BCP 47 tag such as `de` or `pt-BR`, answered as '' when the convar is unset or not a
 * tag, so the client falls through to the player's own browser language and then English.
 * The player's own choice in Settings > Language always wins over this; it is a default
 * for a community, not a lock.
 */
const LOCALE_CONVAR = 'mica_locale';
const LOCALE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const serverLocale = (): string => {
  const configured = GetConvar(LOCALE_CONVAR, '').trim();
  if (!configured) return '';
  if (!LOCALE_TAG.test(configured)) {
    console.warn(
      `[micaOS] ${LOCALE_CONVAR} is '${configured}', which is not a language tag such as ` +
        "'de' or 'pt-BR'. Ignoring it; players fall back to their own language."
    );
    return '';
  }
  return configured;
};

app.registerEvent('locale', async () => ({ locale: serverLocale() }));

/**
 * Which apps the owner switched off and what the phone's dock holds (MICA-234), from
 * `mica_disabled_apps` and `mica_default_dock`, parsed by `shared/ownerConfig.ts`. Same shape
 * as the two above: read per call, nothing read from the payload. Default contacts are not
 * here; the server seeds them into a new phone's rows (`services/Contacts.ts`).
 */
app.registerEvent('ownerConfig', async () => ownerConfig());
