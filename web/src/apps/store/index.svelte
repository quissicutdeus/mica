<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    useAppRegistry,
    useAppRegistryWrite,
    useNavigation,
    type AppManifest,
    ConfirmDialog,
    Screen,
    SegmentedControl,
    useAppAction,
    type AppProps,
    type AppUpdate,
    onAppForeground,
    useLocale,
    useDisplay,
    registerMessages
  } from '@mica/sdk';
  import { useCapabilities } from '@mica/sdk/core';
  import {
    deviceUnavailableReason,
    formatPermission,
    mergedCatalogApps,
    unavailableReason
  } from './appInfo';
  import {
    createStoreActions,
    filterInstalled,
    type InstalledFilter,
    type InstalledSortOrder,
    type PendingConsent
  } from './actions';
  import AppDetails from './components/AppDetails.svelte';
  import CatalogList from './components/CatalogList.svelte';
  import InstalledList from './components/InstalledList.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // MICA-215: registered here, at the app's entry point, so every screen in the Store —
  // the two lists and the details page — reads out of one catalog under `store.`.
  registerMessages('store', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  // Starts empty; `mergedCatalogApps` (bundled add-ons + whatever the configured catalog
  // returns) fills it in once the fetch below resolves. `catalogApps()` is not called
  // directly here any more — `mergedCatalogApps` already calls it internally.
  let catalogAppsList = $state<AppManifest[]>([]);

  const { registryStore, updatesStore } = useAppRegistry();
  const registry = useAppRegistryWrite();
  const { refreshUpdates, fetchRemoteCatalog } = registry;

  const { openApp: openPhoneApp } = useNavigation();
  const { run } = useAppAction('store');
  // A store, so the reason appears when the server's answer does; `missing` is [] until then.
  const caps = useCapabilities();
  const { device } = useDisplay();

  /**
   * MICA-169: see `unavailableReason` — unavailable apps are shown with a reason, not hidden.
   * MICA-264: and an add-on this device does not run comes first, since nothing a server
   * could add would change that answer.
   */
  const unavailableFor = (app: AppManifest): string | null =>
    deviceUnavailableReason(app.devices, $device, $t) ??
    unavailableReason(app.requires, (requires) => $caps.missing(requires), $t);

  /**
   * `onAppForeground`, not `$effect`/`onMount` (§11): apps are resident, so a fetch that ran
   * once per session would show whichever catalog was live the first time the Store was
   * opened for the rest of the phone's life — and the whole point of the update check is
   * that the catalog moves underneath you. Re-asked on every visit.
   */
  onAppForeground('store', () => {
    void mergedCatalogApps(fetchRemoteCatalog).then((apps) => (catalogAppsList = apps));
    void refreshUpdates();
  });

  let activeTab = $state<'catalog' | 'installed'>('catalog');
  let installedFilter = $state<InstalledFilter>('all');
  let installedSortOrder = $state<InstalledSortOrder>('newest');
  let selectedApp = $state<AppManifest | null>(null);
  let appToUninstall = $state<AppManifest | null>(null);
  /**
   * An update whose catalog entry asks for more than the installed app was granted
   * (MICA-196). Held until the player says yes, because tapping Update on a row that
   * shows a version number is not consent to a list they have not been shown.
   */
  let updateToAccept = $state<PendingConsent | null>(null);

  const isInstalled = (appId: string): boolean => $registryStore.some((a) => a.id === appId);

  /** The pending update for an app, if the catalog has moved past what is installed. */
  const updateFor = (appId: string): AppUpdate | null =>
    $updatesStore.find((u) => u.appId === appId) ?? null;

  const filteredInstalledApps = $derived(
    filterInstalled($registryStore, installedFilter, installedSortOrder)
  );

  // Install, update and uninstall, shared with `tablet.svelte` (`actions.ts`).
  const actions = createStoreActions({
    t: () => $t,
    run,
    registry,
    updateFor,
    unavailableFor,
    askConsent: (pending) => (updateToAccept = pending),
    onUninstalled: (app) => {
      if (selectedApp?.id === app.id) selectedApp = null;
    }
  });
  const handleInstall = actions.install;
  const handleUpdate = actions.update;

  function confirmPermissionUpdate() {
    const pending = updateToAccept;
    updateToAccept = null;
    if (!pending) return;
    actions.confirmUpdate(pending);
  }

  const requestUninstall = (app: AppManifest) => (appToUninstall = app);

  function confirmUninstall() {
    if (!appToUninstall) return;
    const target = appToUninstall;
    appToUninstall = null;
    void actions.uninstall(target);
  }
</script>

<div
  class="bg-surface text-on-secondary selection:bg-secondary selection:text-on-secondary relative flex h-full w-full flex-col overflow-hidden"
>
  {#if selectedApp}
    <AppDetails
      app={selectedApp}
      installed={isInstalled(selectedApp.id)}
      unavailable={unavailableFor(selectedApp)}
      update={updateFor(selectedApp.id)}
      onback={() => (selectedApp = null)}
      oninstall={handleInstall}
      onupdate={handleUpdate}
      onuninstall={requestUninstall}
      onopen={openPhoneApp}
    />
  {:else}
    <Screen title={$t('store.title')} {onback}>
      <div class="space-y-4 p-4">
        <!--
          Shown on both tabs, because a player who opened the Store from the launcher badge
          has no idea which tab the news is on. Tapping it goes where the buttons are.
        -->
        {#if $updatesStore.length > 0}
          <button
            onclick={() => {
              activeTab = 'installed';
              installedFilter = 'addon';
            }}
            class="bg-primary-container text-on-primary-container text-body-small duration-short ease-standard flex w-full items-center justify-between gap-2 rounded-box px-3 py-2 text-left transition active:scale-95"
          >
            <span>
              {$t(
                $updatesStore.length === 1
                  ? 'store.updatesAvailableOne'
                  : 'store.updatesAvailableOther',
                { count: $updatesStore.length }
              )}
            </span>
            <span aria-hidden="true">›</span>
          </button>
        {/if}

        <SegmentedControl
          aria-label={$t('store.sections')}
          selected={activeTab}
          onchange={(id) => (activeTab = id as 'catalog' | 'installed')}
          options={[
            { id: 'catalog', label: $t('store.tabCatalog') },
            { id: 'installed', label: $t('store.tabInstalled', { count: $registryStore.length }) }
          ]}
        />

        {#if activeTab === 'catalog'}
          <CatalogList
            apps={catalogAppsList}
            {isInstalled}
            onselect={(app: AppManifest) => (selectedApp = app)}
            oninstall={handleInstall}
            onuninstall={requestUninstall}
            unavailable={unavailableFor}
          />
        {:else}
          <InstalledList
            apps={filteredInstalledApps}
            updates={$updatesStore}
            bind:filter={installedFilter}
            bind:sortOrder={installedSortOrder}
            onselect={(app: AppManifest) => (selectedApp = app)}
            onopen={openPhoneApp}
            onupdate={handleUpdate}
          />
        {/if}
      </div>
    </Screen>
  {/if}

  <!-- MICA-196: an update asking for more than the installed version was granted -->
  {#if updateToAccept}
    {@const added = updateToAccept.added.map((p) => formatPermission(p, $t).label).join(', ')}
    <ConfirmDialog
      title={$t('store.moreAccessTitle', { name: updateToAccept.update.name })}
      message={$t('store.moreAccessMessage', {
        version: updateToAccept.update.availableVersion,
        added
      })}
      confirmText={$t('store.updateAnyway')}
      cancelText={$t('store.keepThisVersion')}
      onconfirm={confirmPermissionUpdate}
      oncancel={() => (updateToAccept = null)}
    />
  {/if}

  <!-- Confirm Uninstall Modal -->
  {#if appToUninstall}
    <ConfirmDialog
      title={$t('store.uninstallTitle', { name: appToUninstall.name })}
      message={$t('store.uninstallMessage', { name: appToUninstall.name })}
      confirmText={$t('store.uninstall')}
      cancelText={$t('store.cancel')}
      confirmVariant="danger"
      onconfirm={confirmUninstall}
      oncancel={() => (appToUninstall = null)}
    />
  {/if}
</div>
