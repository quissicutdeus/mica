import { derived, type Readable } from 'svelte/store';
import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { store, type AsTwin } from './_shared';
import type { AppNotificationPolicy } from '../../../../shell/state/notificationPolicy';

type Twin = AsTwin<
  ReturnType<typeof import('../../inProcess/facets/notificationSettings').notificationSettings>
>;

const refused = () => {
  throw new Error('[gPhone] only a core app may change notification settings');
};

const DEFAULT_APP_POLICY: AppNotificationPolicy = { banner: true, sound: true, badge: true };

/**
 * OS Service Hook for notification preferences, seen from inside a sandboxed add-on.
 *
 * **Read-only, and deliberately so** (MICA-63). An add-on may ask whether the player has
 * silenced it — useful for deciding not to bother pushing — and may never answer that question
 * for itself. Letting one change the policy would let it unmute itself, mute a rival, or switch
 * off Do Not Disturb, none of which is an add-on's decision to make.
 *
 * As with `appRegistry`, this is the polite half of the pair: `IframeHostServer`'s
 * `MEMBER_ALLOWLIST` refuses the setters at the boundary, so a raw `postMessage` that skips
 * this twin gets an error rather than a write. These throws just fail earlier and more legibly.
 */
export function notificationSettings(): Twin {
  const policies = store<Record<string, AppNotificationPolicy>>(
    'notificationSettings',
    [],
    'appNotificationPolicies',
    {}
  );

  return {
    toastsEnabled: store('notificationSettings', [], 'toastsEnabled', true),
    notificationSoundEnabled: store('notificationSettings', [], 'notificationSoundEnabled', true),
    badgesEnabled: store('notificationSettings', [], 'badgesEnabled', true),
    dndEnabled: store('notificationSettings', [], 'dndEnabled', false),
    appNotificationPolicies: policies,
    customisedNotificationApps: store('notificationSettings', [], 'customisedNotificationApps', []),
    /**
     * Derived locally from the map above rather than round-tripped: the wire hands back
     * values, not store factories, and the map is already here. Same answer, no extra traffic.
     */
    appPolicyStore: (appId: string): Readable<AppNotificationPolicy> =>
      derived(policies, ($map) => $map[appId] ?? DEFAULT_APP_POLICY),
    setAppNotificationPolicy: refused,
    clearAppNotificationPolicy: refused
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet(
  'notificationSettings',
  notificationSettings as unknown as Facets['notificationSettings']
);
