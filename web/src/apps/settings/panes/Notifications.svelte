<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    SettingsSection,
    ToggleSwitch,
    useAppRegistry,
    useLocale,
    useNotifications,
    useNotificationSettings,
    useNotificationSettingsWrite,
    type AppManifest
  } from '@gos/sdk';

  /**
   * The whole notification policy surface (MICA-63).
   *
   * Three axes — banner, sound, badge — and they exist twice: once globally, as the master
   * switches this pane has always had, and once per app. A per-app switch is ANDed with its
   * global, so turning off **Show Banner Overlay** silences every banner regardless of what any
   * app's row says, and the row is what silences one app while the rest carry on. That is the
   * thing the pane could not do before: the only way to stop Blabber mentions was to stop
   * every banner on the phone.
   *
   * **Do Not Disturb suppresses banners and sound, and nothing else.** The notification is still
   * delivered, still written, still in the shade, still counted on the badge — it just does not
   * interrupt. That is deliberately not airplane mode, which takes the phone off the network so
   * nothing arrives at all. The reasoning, and where the policy is actually enforced, is in
   * `shell/state/notificationPolicy.ts`.
   */
  const { t } = useLocale();
  const {
    toastsEnabled,
    notificationSoundEnabled,
    badgesEnabled,
    dndEnabled,
    appNotificationPolicies
  } = useNotificationSettings();
  const {
    setToastsEnabled,
    setNotificationSoundEnabled,
    setBadgesEnabled,
    setDndEnabled,
    setAppNotificationPolicy
  } = useNotificationSettingsWrite();

  const { registryStore } = useAppRegistry();

  /**
   * Every notification currently in the shade, used only to *discover* senders that are not
   * apps — see `externalGroups`.
   *
   * No `onAppForeground` load: `services/notifications.ts` subscribes to every app event at
   * module scope and refetches the shade on each one, so this store is already live. Loading
   * again here would be a redundant round trip on every visit to the pane.
   */
  const { notificationsStore } = useNotifications();

  /**
   * Only apps that can actually notify are listed.
   *
   * `permissions` is what the shell checks before raising a toast for a pushed event
   * (`nuiMessages.ts`), so an app without `notifications` has nothing here to switch off and a
   * row for it would be three dead controls. `phone` is listed even so — it owns the ringtone,
   * which DND governs, and its badge is the missed-call count.
   */
  const canNotify = (app: AppManifest): boolean =>
    app.id === 'phone' || Boolean(app.permissions?.includes('notifications'));

  const notifyingApps = $derived(
    [...$registryStore].filter(canNotify).sort((a, b) => a.name.localeCompare(b.name))
  );

  /**
   * Apps that have notified this player but are not in the registry — an `ext_<resource>`
   * group from a third-party resource, which the shade already gives its own identity.
   *
   * They are apps for muting purposes and are the case a server owner hits first: a resource
   * spamming the shade is exactly what somebody wants a switch for, and there is no Store page
   * or AppInfo pane to reach it from.
   *
   * The union of two sources, and it needs both. Live notifications alone would list nothing
   * until a resource happened to have something in the shade right now; the policy map alone
   * would list nothing until it had already been muted, which is unreachable.
   */
  const externalGroups = $derived(
    [
      // Seen: a resource that has actually sent something is one a player wants a switch for.
      ...new Set($notificationsStore.map((item) => item.app)),
      // Already muted: kept listed even after it stops sending, or silencing a group would make
      // its own row vanish and leave no way to turn it back on.
      ...Object.keys($appNotificationPolicies)
    ]
      .filter((id) => id.startsWith('ext_') && !$registryStore.some((app) => app.id === id))
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort()
  );

  const policyFor = (id: string) =>
    $appNotificationPolicies[id] ?? { banner: true, sound: true, badge: true };

  /** `ext_some_resource` reads better as `some resource` next to a row of real app names. */
  const labelForGroup = (id: string): string => id.replace(/^ext_/, '').replace(/_/g, ' ');
</script>

{#snippet appRow(id: string, name: string)}
  {@const policy = policyFor(id)}
  <div class="p-4">
    <div class="text-on-surface text-body-medium mb-3 font-medium">{name}</div>
    <div class="space-y-3 pl-2">
      <div class="flex items-center justify-between">
        <span class="text-on-surface-variant text-body-small"
          >{$t('settings.notifications.banners')}</span
        >
        <ToggleSwitch
          checked={policy.banner}
          onchange={(val: boolean) => setAppNotificationPolicy(id, { banner: val })}
        />
      </div>
      <div class="flex items-center justify-between">
        <span class="text-on-surface-variant text-body-small"
          >{$t('settings.notifications.sound')}</span
        >
        <ToggleSwitch
          checked={policy.sound}
          onchange={(val: boolean) => setAppNotificationPolicy(id, { sound: val })}
        />
      </div>
      <div class="flex items-center justify-between">
        <span class="text-on-surface-variant text-body-small"
          >{$t('settings.notifications.badge')}</span
        >
        <ToggleSwitch
          checked={policy.badge}
          onchange={(val: boolean) => setAppNotificationPolicy(id, { badge: val })}
        />
      </div>
    </div>
  </div>
{/snippet}

<div class="space-y-6 p-4">
  <SettingsSection
    title={$t('settings.notifications.dnd')}
    footer={$t('settings.notifications.dndFooter')}
  >
    <div class="flex items-center justify-between p-4">
      <div class="flex flex-col pr-4">
        <span class="text-on-surface font-medium">{$t('settings.notifications.dnd')}</span>
        <span class="text-on-surface-variant text-body-small"
          >{$t('settings.notifications.dndDescription')}</span
        >
      </div>
      <ToggleSwitch checked={$dndEnabled} onchange={(val: boolean) => setDndEnabled(val)} />
    </div>
  </SettingsSection>

  <SettingsSection title={$t('settings.notifications.bannerSection')}>
    <div class="divide-outline-variant text-body-medium divide-y">
      <div class="flex items-center justify-between p-4">
        <div class="flex flex-col pr-4">
          <span class="text-on-surface font-medium">{$t('settings.notifications.showBanner')}</span>
          <span class="text-on-surface-variant text-body-small"
            >{$t('settings.notifications.showBannerDescription')}</span
          >
        </div>
        <ToggleSwitch checked={$toastsEnabled} onchange={(val: boolean) => setToastsEnabled(val)} />
      </div>

      <div class="flex items-center justify-between p-4">
        <div class="flex flex-col pr-4">
          <span class="text-on-surface font-medium">{$t('settings.notifications.sounds')}</span>
          <span class="text-on-surface-variant text-body-small"
            >{$t('settings.notifications.soundsDescription')}</span
          >
        </div>
        <ToggleSwitch
          checked={$notificationSoundEnabled}
          onchange={(val: boolean) => setNotificationSoundEnabled(val)}
        />
      </div>
    </div>
  </SettingsSection>

  <SettingsSection title={$t('settings.notifications.badgesSection')}>
    <div class="flex items-center justify-between p-4">
      <div class="flex flex-col pr-4">
        <span class="text-on-surface font-medium">{$t('settings.notifications.iconBadges')}</span>
        <span class="text-on-surface-variant text-body-small"
          >{$t('settings.notifications.iconBadgesDescription')}</span
        >
      </div>
      <ToggleSwitch checked={$badgesEnabled} onchange={(val: boolean) => setBadgesEnabled(val)} />
    </div>
  </SettingsSection>

  <SettingsSection
    title={$t('settings.notifications.perApp')}
    footer={$t('settings.notifications.perAppFooter')}
  >
    <div class="divide-outline-variant divide-y">
      {#each notifyingApps as app (app.id)}
        {@render appRow(app.id, app.name)}
      {/each}
    </div>
  </SettingsSection>

  {#if externalGroups.length > 0}
    <SettingsSection
      title={$t('settings.notifications.otherResources')}
      footer={$t('settings.notifications.otherResourcesFooter')}
    >
      <div class="divide-outline-variant divide-y">
        {#each externalGroups as id (id)}
          {@render appRow(id, labelForGroup(id))}
        {/each}
      </div>
    </SettingsSection>
  {/if}
</div>
