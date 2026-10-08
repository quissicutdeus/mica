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
    EmptyState,
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
  import AppDetailsBody from './components/AppDetailsBody.svelte';
  import CatalogList from './components/CatalogList.svelte';
  import InstalledList from './components/InstalledList.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  /**
   * The Store on the tablet (MICA-264): the list on the left, the selected app's details on
   * the right, both on screen at once — the two-pane shape Admin and Notes take on the wide
   * frame (MICA-261). A tablet keeps installs of its own, so this is where it makes them.
   *
   * The same app as `index.svelte`, not a second one: the same catalog, the same wording, and
   * the same install, update and uninstall path (`actions.ts`). Only the layout differs, and
   * the phone's details page — a `Screen` of its own — becomes `AppDetailsBody` in a pane.
   */

  // The same catalog as the phone root: one app, two layouts, never two wordings.
  registerMessages('store', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  let catalogAppsList = $state<AppManifest[]>([]);

  const { registryStore, updatesStore } = useAppRegistry();
  const registry = useAppRegistryWrite();
  const { refreshUpdates, fetchRemoteCatalog } = registry;
  const { openApp } = useNavigation();
  const { run } = useAppAction('store');
  const caps = useCapabilities();
  const { device } = useDisplay();

  /** The phone root's rule, unchanged: this device first, then the server's capabilities. */
  const unavailableFor = (app: AppManifest): string | null =>
    deviceUnavailableReason(app.devices, $device, $t) ??
    unavailableReason(app.requires, (requires) => $caps.missing(requires), $t);

  // `onAppForeground`, not `$effect`/`onMount` (§11), for the reason `index.svelte` gives.
  onAppForeground('store', () => {
    void mergedCatalogApps(fetchRemoteCatalog).then((apps) => (catalogAppsList = apps));
    void refreshUpdates();
  });

  let activeTab = $state<'catalog' | 'installed'>('catalog');
  let installedFilter = $state<InstalledFilter>('all');
  let installedSortOrder = $state<InstalledSortOrder>('newest');
  let appToUninstall = $state<AppManifest | null>(null);
  let updateToAccept = $state<PendingConsent | null>(null);

  /**
   * Which app the detail pane shows, held by id: the manifest behind it changes on install,
   * update and uninstall, and the pane should follow the app rather than a stale copy.
   * Resolved against what is installed first, so an installed app shows its install date.
   */
  let selectedId = $state<string | null>(null);
  const selected = $derived(
    selectedId === null
      ? null
      : ($registryStore.find((a) => a.id === selectedId) ??
          catalogAppsList.find((a) => a.id === selectedId) ??
          null)
  );

  const isInstalled = (appId: string): boolean => $registryStore.some((a) => a.id === appId);

  const updateFor = (appId: string): AppUpdate | null =>
    $updatesStore.find((u) => u.appId === appId) ?? null;

  const filteredInstalledApps = $derived(
    filterInstalled($registryStore, installedFilter, installedSortOrder)
  );

  const actions = createStoreActions({
    t: () => $t,
    run,
    registry,
    updateFor,
    unavailableFor,
    askConsent: (pending) => (updateToAccept = pending),
    // The catalog still lists an uninstalled add-on, so the pane keeps it, now installable.
    onUninstalled: () => {}
  });

  const select = (app: AppManifest) => (selectedId = app.id);

  function confirmPermissionUpdate() {
    const pending = updateToAccept;
    updateToAccept = null;
    if (!pending) return;
    actions.confirmUpdate(pending);
  }

  function confirmUninstall() {
    if (!appToUninstall) return;
    const target = appToUninstall;
    appToUninstall = null;
    void actions.uninstall(target);
  }
</script>

<Screen title={$t('store.title')} {onback}>
  <div class="flex min-h-0 flex-1">
    <!-- The list. `w-96`, the phone's screen width, as Admin's queue is: the same list,
         permanently on screen. It scrolls on its own and clears the home pill. -->
    <div class="border-outline-variant flex min-h-0 w-96 shrink-0 flex-col border-r">
      <div class="space-y-4 p-4">
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
      </div>

      <div class="flex-1 overflow-y-auto px-4 pb-home-indicator">
        {#if activeTab === 'catalog'}
          <CatalogList
            apps={catalogAppsList}
            {isInstalled}
            onselect={select}
            oninstall={actions.install}
            onuninstall={(app: AppManifest) => (appToUninstall = app)}
            unavailable={unavailableFor}
          />
        {:else}
          <InstalledList
            apps={filteredInstalledApps}
            updates={$updatesStore}
            bind:filter={installedFilter}
            bind:sortOrder={installedSortOrder}
            onselect={select}
            onopen={openApp}
            onupdate={actions.update}
          />
        {/if}
      </div>
    </div>

    <!-- The selected app. -->
    <div data-testid="store-detail" class="flex min-h-0 min-w-0 flex-1 flex-col pb-home-indicator">
      {#if selected}
        <AppDetailsBody
          app={selected}
          installed={isInstalled(selected.id)}
          unavailable={unavailableFor(selected)}
          update={updateFor(selected.id)}
          oninstall={actions.install}
          onupdate={actions.update}
          onuninstall={(app: AppManifest) => (appToUninstall = app)}
          onopen={openApp}
        />
      {:else}
        <div class="p-6">
          <EmptyState title={$t('store.selectApp')} description={$t('store.selectAppHint')} />
        </div>
      {/if}
    </div>
  </div>
</Screen>

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
