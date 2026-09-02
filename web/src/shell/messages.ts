// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerMessages, t } from '../../../sdk/i18n';
import en from './locales/en.json';
import de from './locales/de.json';
import serverEn from './locales/server.en.json';
import serverDe from './locales/server.de.json';

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
// MICA-216: what the server says, resolved here because only the client knows the
// player's language. A key the server sends that this catalog lacks falls back to the
// English text beside it; `server/__tests__/serverMessages.test.ts` keeps the two in step.
registerMessages('server', { en: serverEn, de: serverDe });

export { t };
