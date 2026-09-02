// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerMessages, t } from '../../../sdk/i18n';
import en from './locales/en.json';
import de from './locales/de.json';

/**
 * The shell's own strings (MICA-214), registered under the `shell` namespace.
 *
 * An app registers its catalog in its entry component, because an app is only ever
 * rendered whole. The shell is not: `NotificationShade`, `AppCrashed`, `Dock` and the
 * rest are mounted on their own by their unit tests, and a registration that lived in
 * `Shell.svelte` alone would leave every one of them rendering bare keys. Registering
 * here — the module each of them already imports `t` from — makes the catalog arrive with
 * the translator, once, whatever mounts first.
 */
registerMessages('shell', { en, de });

export { t };
