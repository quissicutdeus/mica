// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import { is24HourNow } from '../host/seam/clockPreference';
import { locale, t as translator, type Translate } from '../i18n';
import '../ui/messages';

/**
 * Every `Intl` call below formats under the phone's locale (MICA-61), read at call time so
 * a component that re-renders on a locale change re-formats too. Before this, currency was
 * pinned to `en-US` and dates fell back to whatever the CEF process reported.
 */
const activeLocale = (): string => get(locale);

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat(activeLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString(activeLocale());
}

export function formatTime(isoString?: string | number | Date, override24Hour?: boolean): string {
  if (!isoString) return '';
  const date = isoString instanceof Date ? isoString : new Date(isoString);
  if (isNaN(date.getTime())) return '';

  const use24 = override24Hour ?? is24HourNow();

  if (use24) {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  return date.toLocaleTimeString(activeLocale(), {
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * How long ago, in the phone's language: "Just now", "5m ago", "3h ago", "Yesterday", then
 * the date (MICA-412). The words are the `ui` catalog's (`ui.justNow`, `ui.minutesAgo`,
 * `ui.hoursAgo`, `ui.yesterday`), so an owner's `locales/` files translate them like any
 * other SDK string; the date past yesterday is `Intl` under the active locale.
 *
 * The catalog rather than `Intl.RelativeTimeFormat`: its narrow English differs between
 * Chromium 103's ICU and a current one ("5 min. ago" against "5m ago"), and a catalog
 * reads the same in game, in the dev browser and in a test.
 *
 * **Re-rendering on a locale switch:** called bare, it reads the locale when it runs, so a
 * template that calls it re-formats only when something else re-renders it. Pass the
 * translator — `formatRelativeTime(at, $t)`, `$t` from `useLocale()` — and the expression
 * depends on `$t`, which changes with the locale, so it re-formats on the switch.
 */
export function formatRelativeTime(dateStr: Date | string, t?: Translate): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  const translate = t ?? get(translator);
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (minutes < 1) return translate('ui.justNow');
  if (minutes < 60) return translate('ui.minutesAgo', { minutes });
  if (hours < 24) return translate('ui.hoursAgo', { hours });
  if (days === 1) return translate('ui.yesterday');
  return date.toLocaleDateString(activeLocale(), { month: 'short', day: 'numeric' });
}

export function formatDate(isoString?: string | number | Date): string {
  if (!isoString) return '';
  const date = isoString instanceof Date ? isoString : new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString(activeLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Seconds as `m:ss`, or `h:mm:ss` past an hour. MICA-111.
 *
 * Here rather than inline in the Music app because a "how long" readout is not
 * app-specific: `MediaThumb` and the Phone app's call timer each wrote their own, and
 * separate copies are how surfaces end up disagreeing about what 90 seconds looks like.
 * Both read through this one now (MICA-417).
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}
