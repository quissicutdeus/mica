// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import type { OwnerConfig } from '../ownerConfig';
import { s } from '../schema';

/**
 * The phone itself — `shell` is one of the two non-app service scopes, and the only contract
 * split across two endpoints.
 *
 * `server/services/Capabilities.ts` and `server/services/Source.ts` each construct their own
 * `ServiceEndpoint('shell', …)` and register one action, so both pass this same contract and
 * each is checked against its own half of it. That is why the contract is keyed on the service
 * id rather than on an endpoint: the id is what the `<service>` segment of an event carries,
 * and nothing on the wire knows which file registered a handler.
 *
 * Neither action reads a payload. The answer is a property of the server, identical for every
 * caller, so `s.none()` is the honest declaration — and it also means growing one is a decision
 * somebody makes rather than something a client asserts.
 */
export const shellContract = defineContract({
  id: 'shell',
  actions: {
    /**
     * The shape is spelled out rather than imported: `Capabilities` is declared in
     * `server/services/Capabilities.ts`, and `shared/` cannot reach into `server/`. Two
     * booleans are not worth moving a type for, but the authority is there and not here.
     */
    capabilities: {
      input: s.none(),
      output: responseType<{ money: boolean; jobs: boolean }>()
    },
    sourceUrl: { input: s.none(), output: responseType<{ url: string }>() },
    /** MICA-61: the owner's default language (`mica_locale`), or '' when unset. */
    locale: { input: s.none(), output: responseType<{ locale: string }>() },
    /** MICA-234: `mica_disabled_apps` and `mica_default_dock`, parsed by `shared/ownerConfig`. */
    ownerConfig: { input: s.none(), output: responseType<OwnerConfig>() }
  }
});
