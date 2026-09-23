// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { call, callOr } from '../nui/call';
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
 * Every preference this character has — or a rejection, deliberately, on any failure
 * including the "Player not authenticated" reply the CEF page gets at resource start,
 * before a character is selected.
 *
 * MICA-287: this used to default to `[]` on failure (`callOr`, quieted for exactly that
 * boot-time reply). That collapsed "this character has zero saved rows" and "the request
 * never reached the server" into the same value, and the character-switch hydrate in
 * `host/facets/storage.ts` needs to tell them apart — it clears a locally cached setting
 * the new character's answer does not include, and doing that off an `[]` that might only
 * mean "failed" would wipe a working phone on a bad connection. `call` throws instead of
 * defaulting, which is the only way to carry that distinction to the caller.
 *
 * Still quiet in practice: `fetchNui` only prints its own warning on the defaulting path,
 * never on the one that throws, so the expected boot-time failure costs no console line
 * here either — `hydrateSettingsInProcess` decides on its own whether the rejection is
 * worth logging.
 *
 * `onboarding.ts`'s one call site (`migrateAppDrawerHintForExistingSaves`) chains directly
 * off the very first, boot-time `hydrateSettings()` call in `Shell.svelte` — the same
 * pre-authentication window this docstring is about — so it now catches the rejection and
 * skips quietly, the same "nothing happens" outcome the old `[]` produced for it.
 */
export const fetchSettings = (): Promise<PhoneSetting[]> =>
  call(settingsContract, 'getAll', undefined);

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
