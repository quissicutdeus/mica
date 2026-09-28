// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import type { OwnerConfig } from '../ownerConfig';
import type { ShellCapabilities } from '../types';
import { s } from '../schema';

/**
 * The phone itself — `shell` is one of the two non-app service scopes, and the only contract
 * split across several endpoints.
 *
 * `server/services/Capabilities.ts`, `server/services/Source.ts` and
 * `server/services/MediaHost.ts` each construct their own `ServiceEndpoint('shell', …)` and
 * register their actions, so all pass this same contract and each is checked against its own
 * part of it. That is why the contract is keyed on the service id rather than on an endpoint:
 * the id is what the `<service>` segment of an event carries, and nothing on the wire knows
 * which file registered a handler.
 *
 * Neither action reads a payload. The answer is a property of the server, identical for every
 * caller, so `s.none()` is the honest declaration — and it also means growing one is a decision
 * somebody makes rather than something a client asserts.
 */
export const shellContract = defineContract({
  id: 'shell',
  actions: {
    /** `ShellCapabilities` in `shared/types.ts` is the shape, and says what each field means. */
    capabilities: {
      input: s.none(),
      output: responseType<ShellCapabilities>()
    },
    sourceUrl: { input: s.none(), output: responseType<{ url: string }>() },
    /**
     * MICA-243: the origin hosted photos are served from, `https://<host>`, or `null` when
     * photos stay in the database. The add-on CSP adds it to `img-src` and nowhere else.
     */
    imageHost: { input: s.none(), output: responseType<{ origin: string | null }>() },
    /** MICA-61: the owner's default language (`mica_locale`), or '' when unset. */
    locale: { input: s.none(), output: responseType<{ locale: string }>() },
    /**
     * MICA-235: every language with at least one valid file in the resource's `locales/`
     * folder, `en` first and always, the rest sorted. Read at resource start, so an owner adds a
     * language by dropping files in and restarting — no rebuild.
     */
    locales: { input: s.none(), output: responseType<{ languages: string[] }>() },
    /**
     * MICA-235: one language's messages, namespace → key → text, or `{}` for a language with no
     * files. The tag is a language tag and nothing else (letters, digits and hyphens, the shape
     * `normalizeLocale` accepts), so `..` and slashes are refused before any handler runs — and
     * the handler only ever looks it up among the languages already read, never opens a path.
     */
    catalog: {
      input: s.object({
        locale: s.string({ trim: true, max: 35, pattern: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/ })
      }),
      output: responseType<{ catalogs: Record<string, Record<string, string>> }>()
    },
    /** MICA-234: `mica_disabled_apps` and `mica_default_dock`, parsed by `shared/ownerConfig`. */
    ownerConfig: { input: s.none(), output: responseType<OwnerConfig>() }
  }
});
