// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { callOr } from '../nui/call';
import { settingsContract } from '@mica/shared/contracts/settings';
import type { PhoneSetting } from '@mica/shared/types';

/**
 * The client half of the `settings` service.
 *
 * Thin on purpose: there is no store here. Every preference already has one — `themeStore`,
 * `displaySize`, `volumeStep` — built on `usePersisted`, and a second store holding the same
 * values is the drift this codebase keeps paying for. What the phone needs from the server is
 * a hydrate at boot and a write on change, which is what these three functions are.
 *
 * Reached from `sdk/host/settingsSync.ts`, not from an app. Apps see `useStorage`.
 */

/**
 * Every preference this character has. `[]` for a browser with no server behind it.
 *
 * `quiet: true` because the CEF page hydrates at resource start, before a character is
 * selected — the server's "Player not authenticated" reply is the expected first answer,
 * not a failure worth a console warning. `hydrateSettings` already treats any failure here
 * as tolerable by design ("keeping the values already on the phone" beats resetting a
 * working phone over one bad request), so there is no later call where this same warning
 * would suddenly mean something — quieting it here is consistent with that, not a special
 * case for the boot-time one.
 */
export const fetchSettings = (): Promise<PhoneSetting[]> =>
  callOr(settingsContract, 'getAll', undefined, [] as PhoneSetting[], { quiet: true });

/**
 * Write one key. `value` is the JSON string `useStorage` already produced.
 *
 * Failure is swallowed by `fetchNui`'s default rather than thrown. A preference that did
 * not reach the server is still applied locally, and a toast about it would be noise for
 * something the player did not ask to do — the next write retries anyway.
 *
 * `quiet: true` for the same reason `fetchSettings` above is quiet: a store can write back
 * through `usePersisted` during the same boot window `fetchSettings` already accounts for
 * — before a character is selected — and "Player not authenticated" is the expected first
 * answer there too, not a failure worth a console warning.
 */
export const saveSetting = (app: string, key: string, value: string): Promise<boolean> =>
  callOr(settingsContract, 'set', { app, key, value }, false, { quiet: true });

export const removeSetting = (app: string, key: string): Promise<boolean> =>
  callOr(settingsContract, 'remove', { app, key }, false);

export const clearAppSettings = (app: string): Promise<boolean> =>
  callOr(settingsContract, 'clearApp', { app }, false);
