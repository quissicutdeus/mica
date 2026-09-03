// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['notificationSettingsWrite']>>;

const refused = () => {
  throw new Error('[gOS] only a core app may change notification settings');
};

/**
 * OS Service Hook for changing notification preferences, seen from inside a sandboxed
 * add-on. Every member throws locally — letting an add-on mute a rival, unmute itself, or
 * switch off Do Not Disturb is not something any manifest permission grants it. The shell
 * refuses it too: `IframeHostServer`'s `MEMBER_ALLOWLIST` lists no member for this facet
 * at all, so a raw `postMessage` that skips this twin gets an error rather than a write.
 * These throws just fail earlier and more legibly.
 */
export function notificationSettingsWrite(): Twin {
  return {
    setToastsEnabled: refused,
    setNotificationSoundEnabled: refused,
    setBadgesEnabled: refused,
    setDndEnabled: refused,
    setAppNotificationPolicy: refused,
    clearAppNotificationPolicy: refused
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('notificationSettingsWrite', notificationSettingsWrite);
