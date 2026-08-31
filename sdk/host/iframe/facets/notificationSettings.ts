import { derived, type Readable } from 'svelte/store';
import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { store, type AsTwin } from './_shared';
import type { AppNotificationPolicy } from '../../../vocabulary/shell';

type Twin = AsTwin<ReturnType<Facets['notificationSettings']>>;

const DEFAULT_APP_POLICY: AppNotificationPolicy = { banner: true, sound: true, badge: true };

/**
 * OS Service Hook for notification preferences, seen from inside a sandboxed add-on —
 * read-only, and deliberately so (MICA-63/MICA-127). An add-on may ask whether the
 * player has silenced it — useful for deciding not to bother pushing — and may never
 * change the answer. Muting a rival, unmuting itself, or flipping Do Not Disturb is
 * `useNotificationSettingsWrite`, whose members `IframeHostServer`'s `MEMBER_ALLOWLIST`
 * still refuses regardless of permission: none of this is an add-on's decision to make.
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
      derived(policies, ($map) => $map[appId] ?? DEFAULT_APP_POLICY)
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
