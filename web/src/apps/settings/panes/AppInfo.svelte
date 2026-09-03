<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    appStorageBytes,
    clearAppStorage,
    Button,
    ConfirmDialog,
    formatDate,
    SettingsSection,
    ToggleSwitch,
    useAppAction,
    useAppRegistryWrite,
    useLocale,
    useNotificationSettings,
    useNotificationSettingsWrite,
    AppIconTile,
    type AppManifest
  } from '@gos/sdk';

  /**
   * One app, and the two things a player can do to it.
   *
   * **Clear storage** returns it to a freshly installed state without removing it. **Uninstall**
   * runs the registry's own `unregisterApp`, which is what the Store calls — so there is one
   * removal path rather than two that can disagree about what gets cleaned up. It sweeps the
   * app's storage, forgets a remote bundle's saved URL, and drops the app from the launcher.
   *
   * Uninstall is absent for a system app rather than present and failing. `unregisterApp` throws
   * for a core id, and the Store has already shipped the other version of this: it derived
   * "system" separately from the registry, the two answers differed, and it rendered a button
   * that could only error. `manifest.core` is the one answer.
   */
  let {
    app,
    onremoved
  }: {
    app: AppManifest;
    onremoved: () => void;
  } = $props();

  const { t } = useLocale();
  const { unregisterApp } = useAppRegistryWrite();
  const { run, busy } = useAppAction('settings');

  /**
   * The second entry point to this app's notification switches (MICA-63).
   *
   * The same three values Settings > Notifications shows in its per-app list, on the pane a
   * player is already looking at when they think "this app specifically". One store behind
   * both, so the two surfaces cannot disagree.
   *
   * Only shown for an app that can actually notify — `permissions` is what the shell checks
   * before raising a toast for a pushed event, so for anything else these would be three dead
   * controls. `phone` is the exception: it owns the ringtone and the missed-call badge.
   */
  const { appNotificationPolicies } = useNotificationSettings();
  const { setAppNotificationPolicy, clearAppNotificationPolicy } = useNotificationSettingsWrite();

  const canNotify = $derived(
    app.id === 'phone' || Boolean(app.permissions?.includes('notifications'))
  );
  const policy = $derived(
    $appNotificationPolicies[app.id] ?? { banner: true, sound: true, badge: true }
  );

  let confirming = $state<'clear' | 'uninstall' | null>(null);

  /**
   * Storage is read on demand, not subscribed — there is no store behind localStorage. So a
   * clear has to nudge the read: `app` has not changed, and the byte count has.
   */
  let storageVersion = $state(0);
  const bytes = $derived.by(() => {
    void storageVersion;
    return appStorageBytes(app.id);
  });
  const storageLabel = $derived(
    bytes === 0
      ? $t('settings.appInfo.nothingStored')
      : bytes < 1024
        ? `${bytes} B`
        : `${(bytes / 1024).toFixed(1)} KB`
  );

  const clear = async (): Promise<void> => {
    confirming = null;
    if (
      await run(() => clearAppStorage(app.id), {
        title: app.name,
        success: $t('settings.appInfo.storageCleared')
      })
    ) {
      storageVersion += 1;
    }
  };

  const uninstall = async (): Promise<void> => {
    confirming = null;
    // Read once, before anything is awaited. `app` is a prop the parent derives from the
    // registry, and `unregisterApp` is what drops the app from the registry — so by the time
    // it resolves the parent has already derived `null`, unmounted this pane, and the prop
    // answers `null`. Reading `app.id` after the await threw on every uninstall (MICA-207).
    const { id, name } = app;
    // `run` reports the failure for us — `unregisterApp` throws for a core app, and this button
    // is not rendered for one, so a throw here means something the player should be told about.
    if (
      await run(() => unregisterApp(id), {
        title: name,
        success: $t('settings.appInfo.uninstalled')
      })
    ) {
      // Forget the mutes along with the app, so a reinstall starts allowed rather than
      // inheriting a silence the player set months ago and has no reason to remember.
      clearAppNotificationPolicy(id);
      onremoved();
    }
  };
</script>

<div class="space-y-6 p-4">
  <div class="flex items-center gap-3">
    <AppIconTile name={app.name} icon={app.icon} color={app.color} size="lg" />
    <div class="min-w-0">
      <p class="text-on-surface text-body-large truncate">{app.name}</p>
      <p class="text-on-surface-variant text-body-small truncate">
        {app.core
          ? $t('settings.appInfo.systemApp')
          : $t('settings.appInfo.storeAddOn')}{app.isRemote
          ? $t('settings.appInfo.remoteSuffix')
          : ''}
      </p>
      {#if app.description}
        <p class="text-on-surface text-body-small mt-1">{app.description}</p>
      {/if}
    </div>
  </div>

  <SettingsSection title={$t('settings.appInfo.details')}>
    <div class="divide-outline-variant text-body-medium divide-y">
      <div class="flex items-center justify-between p-4">
        <span class="text-on-surface-variant">{$t('settings.appInfo.identifier')}</span>
        <span class="text-on-surface text-body-small font-mono">{app.id}</span>
      </div>
      <div class="flex items-center justify-between p-4">
        <span class="text-on-surface-variant">{$t('settings.appInfo.author')}</span>
        <span class="text-on-surface">{app.author || $t('settings.appInfo.defaultAuthor')}</span>
      </div>
      {#if app.version}
        <div class="flex items-center justify-between p-4">
          <span class="text-on-surface-variant">{$t('settings.appInfo.version')}</span>
          <span class="text-on-surface">{app.version}</span>
        </div>
      {/if}
      {#if app.installedAt}
        <div class="flex items-center justify-between p-4">
          <span class="text-on-surface-variant">{$t('settings.appInfo.installed')}</span>
          <span class="text-on-surface">{formatDate(app.installedAt)}</span>
        </div>
      {/if}
      <div class="flex items-center justify-between p-4">
        <span class="text-on-surface-variant">{$t('settings.appInfo.storageUsed')}</span>
        <span class="text-on-surface">{storageLabel}</span>
      </div>
    </div>
  </SettingsSection>

  {#if canNotify}
    <SettingsSection
      title={$t('settings.notifications.title')}
      footer={$t('settings.appInfo.notificationsFooter')}
    >
      <div class="divide-outline-variant text-body-medium divide-y">
        <div class="flex items-center justify-between p-4">
          <span class="text-on-surface-variant">{$t('settings.notifications.banners')}</span>
          <ToggleSwitch
            checked={policy.banner}
            onchange={(val: boolean) => setAppNotificationPolicy(app.id, { banner: val })}
          />
        </div>
        <div class="flex items-center justify-between p-4">
          <span class="text-on-surface-variant">{$t('settings.notifications.sound')}</span>
          <ToggleSwitch
            checked={policy.sound}
            onchange={(val: boolean) => setAppNotificationPolicy(app.id, { sound: val })}
          />
        </div>
        <div class="flex items-center justify-between p-4">
          <span class="text-on-surface-variant">{$t('settings.notifications.badge')}</span>
          <ToggleSwitch
            checked={policy.badge}
            onchange={(val: boolean) => setAppNotificationPolicy(app.id, { badge: val })}
          />
        </div>
      </div>
    </SettingsSection>
  {/if}

  <div>
    <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
      {$t('settings.appInfo.manage')}
    </h2>
    <div class="space-y-2">
      <Button
        variant="secondary"
        class="w-full"
        disabled={$busy || bytes === 0}
        onclick={() => (confirming = 'clear')}
      >
        {$t('settings.appInfo.clearStorage')}
      </Button>
      <p class="text-on-surface-variant text-body-small px-2">
        {bytes === 0 ? $t('settings.appInfo.nothingToClear') : $t('settings.appInfo.clearHint')}
      </p>

      {#if app.core}
        <p class="text-on-surface-variant text-body-small px-2 pt-2">
          {$t('settings.appInfo.coreNote')}
        </p>
      {:else}
        <Button
          variant="danger"
          class="mt-2 w-full"
          disabled={$busy}
          onclick={() => (confirming = 'uninstall')}
        >
          {$t('settings.appInfo.uninstall')}
        </Button>
        <p class="text-on-surface-variant text-body-small px-2">
          {$t('settings.appInfo.uninstallHint')}
        </p>
      {/if}
    </div>
  </div>
</div>

{#if confirming === 'clear'}
  <ConfirmDialog
    title={$t('settings.appInfo.clearTitle', { name: app.name })}
    message={$t('settings.appInfo.clearMessage', { name: app.name })}
    confirmText={$t('settings.appInfo.clearConfirm')}
    onconfirm={clear}
    oncancel={() => (confirming = null)}
  />
{:else if confirming === 'uninstall'}
  <ConfirmDialog
    title={$t('settings.appInfo.uninstallTitle', { name: app.name })}
    message={$t('settings.appInfo.uninstallMessage', { name: app.name })}
    confirmText={$t('settings.appInfo.uninstall')}
    onconfirm={uninstall}
    oncancel={() => (confirming = null)}
  />
{/if}
