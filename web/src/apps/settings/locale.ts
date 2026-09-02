// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { usePersisted } from '@gphone/sdk';

/**
 * The player's own language choice, as Settings shows it: '' is "Automatic". The same
 * persisted key `shell/state/locale.ts` resolves from, reached through the SDK rather than
 * by path because an app may not import shell state (AGENTS.md §2.7).
 */
export const localeSetting = usePersisted<string>('settings', 'locale', '');
