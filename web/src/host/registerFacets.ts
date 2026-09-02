// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The in-process facet set — one side of the SDK's host seam, and the shell's half of it.
 *
 * MICA-176. Until this file existed the choice between the two facet sets was made by
 * a build alias: every `useXxx.ts` hook opened with `import '../../../sdk/host/inProcess/inProcess/facets/<name>';`
 * and `facetSwap()` in `vite.addon.config.ts` rewrote that one specifier to
 * `iframe/facets/<name>` for the add-on build. One source line, two resolutions, decided
 * by a `resolveId` plugin — so what an add-on bundle actually contained was a property of
 * a plugin's regex rather than of anything you could read in the source.
 *
 * Now the entry point picks. `src/main.ts` (the shell) imports this file; `bootAddOn`
 * imports `../iframe/registerFacets` instead. Each facet module still self-registers into
 * `current.ts`'s registry at its own bottom — that runtime seam is unchanged — but nothing
 * decides *which* module that is except which of these two files got imported.
 *
 * **Nothing in `current.ts`'s or `guard.ts`'s import graph may reach this file.** Those two
 * (and `system.ts`, `createInProcessHost.ts`) are deliberately free of any module that
 * imports `shell/`; `current.ts`'s only reference to a facet is the type-only
 * `import type { Facets } from '../../../sdk/host/facets'`. This file is the opposite — 46 of the 48
 * modules below import `shell/`, `services/` or `nui/` by value — so it is imported *by*
 * the entry point and *by nothing else*. Importing it from a hook, from `guard.ts`, or
 * from anything either of those reaches recreates exactly the cycle that arrangement exists
 * to avoid.
 *
 * Side-effect imports, not re-exports: the registration *is* the effect. The list is
 * exhaustive by test, not by convention — `seam.test.ts`'s "the boot facet sets are
 * exhaustive" describe compares it against the directory, so a facet added and not listed
 * here fails the suite instead of silently never registering.
 */
/**
 * `persisted` is imported first, and the order is load-bearing.
 *
 * Six `shell/state/*` modules build a settings store at *module scope* —
 * `export const soundVolume = usePersisted('settings', 'soundVolume', 0.5)` in `audio.ts`,
 * and the same shape in `airplane`, `bluetooth`, `flashlight`, `signal` and `charge`. Those
 * modules are pulled in by other facets further down this list, and `usePersisted` resolves
 * `facets.persisted` the moment it is called — so if a facet that reaches `audio.ts` is
 * evaluated before `persisted.ts` has registered, boot dies with
 * `host facet 'persisted' is not loaded`.
 *
 * Before MICA-176 nothing had to say this: each hook imported its own facet, so
 * `audio.ts`'s `import { usePersisted } from '../../../sdk/host/usePersisted'` *was* the guarantee that
 * `persisted` had registered — ES modules finish evaluating a dependency before the
 * importer's body runs. Moving the choice of facet set to the entry point is what gives
 * that guarantee up, and this line is what replaces it.
 *
 * The failure is loud rather than silent — a hard throw during boot, and the unit suite
 * imports this file cold in every one of its ~165 files (`vitest.setup.ts`), so a new
 * module-scope hook call that needs a different facet first fails the whole suite rather
 * than one screen in game. `storage.ts` is not listed separately: `persisted.ts` imports
 * it, so it is evaluated first anyway.
 *
 * **Do not alphabetise this line back into the list below.** It reads as an arbitrary
 * exception and is not one: the list is otherwise sorted, and this one entry is ordered by
 * a dependency the sort cannot see.
 */
import './facets/persisted';

import './facets/account';
import './facets/accounts';
import './facets/admin';
import './facets/sourceUrl';
import './facets/locale';
import './facets/appAction';
import './facets/appEvents';
import './facets/appLevels';
import './facets/appRegistry';
import './facets/appRegistryWrite';
import './facets/bank';
import './facets/call';
import './facets/camera';
import './facets/clock';
import './facets/clockWrite';
import './facets/contacts';
import './facets/deepLink.svelte';
import './facets/devTools';
import './facets/display';
import './facets/displayWrite';
import './facets/highscores';
import './facets/keybinds';
import './facets/keybindsWrite';
import './facets/lifecycle';
import './facets/location';
import './facets/lockScreen';
import './facets/lockScreenWrite';
import './facets/mail';
import './facets/marketplace';
import './facets/media';
import './facets/messages';
import './facets/music';
import './facets/navigation';
import './facets/notificationSettings';
import './facets/notificationSettingsWrite';
import './facets/notifications';
import './facets/phoneNotification';
import './facets/report';
import './facets/reports';
import './facets/service';
import './facets/sound';
import './facets/storage';
import './facets/systemHardware';
import './facets/systemHardwareWrite';
import './facets/theme';
import './facets/themeWrite';
import './facets/timer';
import './facets/wallpaper';
import './facets/wallpaperWrite';
