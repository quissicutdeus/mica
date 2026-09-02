// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerMessages } from '../i18n';
import en from './locales/en.json';
import de from './locales/de.json';

/**
 * The `ui` namespace: the strings the SDK's own primitives draw (MICA-214).
 *
 * The SDK is a consumer of its own mechanism here, and registers exactly the way an app
 * does — the catalog is a flat object per locale and nothing central knows about it. What
 * differs is *when*: an app registers at the top of its `index.svelte`, which runs when the
 * app loads, but a primitive has no such moment. `ConfirmDialog` can be the first thing on
 * screen in an add-on that never touches `registerMessages` at all.
 *
 * So this module is the registration, and every primitive that reads a string imports it
 * for the side effect. Whichever one loads first registers the namespace for all of them,
 * and a component with no consumer costs nothing because nothing imports it.
 *
 * The primitives read through `t` from `../i18n` **directly**, not through `useLocale()`.
 * `useLocale` is a host facet and needs a shell to resolve; a primitive has to render in a
 * bare component test with no phone around it, and `t` is a plain store with an English
 * fallback, so it does.
 *
 * This module is internal. It is on no barrel and no add-on can import it — the namespace
 * it registers is the contract, not this file.
 */
registerMessages('ui', { en, de });
