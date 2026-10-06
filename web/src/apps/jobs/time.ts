// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Translate } from '@mica/sdk';

/**
 * "5m ago" in the player's language. The SDK's `formatRelativeTime` answers in English only,
 * so this follows the Phone app's call log instead and reads its words from the catalog.
 */
export const ago = (raw: string, t: Translate): string => {
  const at = new Date(raw).getTime();
  if (Number.isNaN(at)) return '';
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return t('jobs.justNow');
  if (minutes < 60) return t('jobs.minutesAgo', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('jobs.hoursAgo', { hours });
  return t('jobs.daysAgo', { days: Math.floor(hours / 24) });
};
