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
    fetchCatalog,
    getRemoteCatalogUrl,
    onAppForeground
  } from '@gphone/sdk';
  import { mergedCatalogApps } from './appInfo';
  import AppDetails from './components/AppDetails.svelte';
  import CatalogList from './components/CatalogList.svelte';
  import InstalledList from './components/InstalledList.svelte';

  let { onback }: AppProps = $props();

  // Starts empty; `mergedCatalogApps` (bundled add-ons + whatever the configured catalog
  // returns) fills it in once the fetch below resolves. `catalogApps()` is not called
  // directly here any more — `mergedCatalogApps` already calls it internally.
  let catalogAppsList = $state<AppManifest[]>([]);

  const { registryStore, updatesStore } = useAppRegistry();
  const { unregisterApp, registerAddOn, installFromCatalog, refreshUpdates, updateApp } =
    useAppRegistryWrite();

  const { openApp: openPhoneApp } = useNavigation();
  const { run } = useAppAction('store');

  /**
   * `onAppForeground`, not `$effect`/`onMount` (§11): apps are resident, so a fetch that ran
   * once per session would show whichever catalog was live the first time the Store was
   * opened for the rest of the phone's life — and the whole point of the update check is
   * that the catalog moves underneath you. Re-asked on every visit.
   */
  onAppForeground('store', () => {
    void mergedCatalogApps(getRemoteCatalogUrl()).then((apps) => (catalogAppsList = apps));
    void refreshUpdates();
  });

  let activeTab = $state<'catalog' | 'installed'>('catalog');
  let installedFilter = $state<'all' | 'system' | 'addon'>('all');
  let installedSortOrder = $state<'newest' | 'oldest' | 'updated' | 'name'>('newest');
  let selectedApp = $state<AppManifest | null>(null);
  let appToUninstall = $state<AppManifest | null>(null);

  const isInstalled = (appId: string): boolean => $registryStore.some((a) => a.id === appId);

  /** The pending update for an app, if the catalog has moved past what is installed. */
  const updateFor = (appId: string): AppUpdate | null =>
    $updatesStore.find((u) => u.appId === appId) ?? null;

  const filteredInstalledApps = $derived(
    $registryStore
      .filter((app) => {
        if (installedFilter === 'system') return app.core;
        if (installedFilter === 'addon') return !app.core;
        return true;
      })
      .slice()
      .sort((a, b) => {
        if (installedSortOrder === 'name') return a.name.localeCompare(b.name);

        const installedA = a.installedAt ? new Date(a.installedAt).getTime() : 0;
        const installedB = b.installedAt ? new Date(b.installedAt).getTime() : 0;
        const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;

        if (installedSortOrder === 'oldest') {
          return installedA - installedB || a.name.localeCompare(b.name);
        }
        if (installedSortOrder === 'updated') {
          return updatedB - updatedA || a.name.localeCompare(b.name);
        }
        return installedB - installedA || a.name.localeCompare(b.name);
      })
  );

  function handleInstall(app: AppManifest) {
    if (app.isRemote && app.bundleUrl) {
      const target = app;
      void run(
        async () => {
          const catalogUrl = getRemoteCatalogUrl();
          if (!catalogUrl) throw new Error('No add-on catalog is configured on this server.');
          const entries = await fetchCatalog(catalogUrl);
          const entry = entries.find((e) => e.id === target.id);
          if (!entry) throw new Error(`'${target.name}' is no longer in the catalog.`);
          await installFromCatalog(entry);
        },
        { title: 'Store', success: `${app.name} installed successfully!` }
      );
      return;
    }

    // No component to load: a bundled add-on registers as source text, fetched lazily by
    // `getAddOnSource` the first time it is opened, not eagerly here — the shell never
    // `import()`s an add-on's code in-process (MICA-16 step 4).
    void run(() => registerAddOn(app), {
      title: 'Store',
      success: `${app.name} installed successfully!`
    });
  }

  /**
   * Install the catalog's copy of an app that has fallen behind.
   *
   * No confirmation dialog and no second install path: `updateApp` goes through
   * `installFromCatalog`, so the bundle is re-fetched and re-verified against the entry's
   * `sha256` exactly as it was on the first install. The permissions the player accepted are
   * on screen while they tap this — the details view is one tap away from either surface
   * that offers the button, and `AppDetails` lists them.
   */
  function handleUpdate(app: AppManifest) {
    const pending = updateFor(app.id);
    if (!pending) return;
    void run(() => updateApp(app.id), {
      title: 'Store',
      success: `${app.name} updated to v${pending.availableVersion}`
    });
  }

  const requestUninstall = (app: AppManifest) => (appToUninstall = app);

  async function handleUninstall(app: AppManifest) {
    const removed = await run(() => unregisterApp(app.id), {
      title: 'Store',
      success: `${app.name} uninstalled`
    });
    if (removed && selectedApp?.id === app.id) selectedApp = null;
  }

  function confirmUninstall() {
    if (!appToUninstall) return;
    const target = appToUninstall;
    appToUninstall = null;
    void handleUninstall(target);
  }
</script>

<div
  class="bg-surface text-on-secondary selection:bg-secondary selection:text-on-secondary relative flex h-full w-full flex-col overflow-hidden"
>
  {#if selectedApp}
    <AppDetails
      app={selectedApp}
      installed={isInstalled(selectedApp.id)}
      update={updateFor(selectedApp.id)}
      onback={() => (selectedApp = null)}
      oninstall={handleInstall}
      onupdate={handleUpdate}
      onuninstall={requestUninstall}
      onopen={openPhoneApp}
    />
  {:else}
    <Screen title="Store" {onback}>
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
            class="bg-primary-container text-on-primary-container text-body-small duration-short ease-standard flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left transition active:scale-95"
          >
            <span>
              {$updatesStore.length}
              {$updatesStore.length === 1 ? 'add-on has' : 'add-ons have'} an update available
            </span>
            <span aria-hidden="true">›</span>
          </button>
        {/if}

        <SegmentedControl
          aria-label="Store sections"
          selected={activeTab}
          onchange={(id) => (activeTab = id as 'catalog' | 'installed')}
          options={[
            { id: 'catalog', label: 'Store Catalog' },
            { id: 'installed', label: `Installed (${$registryStore.length})` }
          ]}
        />

        {#if activeTab === 'catalog'}
          <CatalogList
            apps={catalogAppsList}
            {isInstalled}
            onselect={(app: AppManifest) => (selectedApp = app)}
            oninstall={handleInstall}
            onuninstall={requestUninstall}
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

  <!-- Confirm Uninstall Modal -->
  {#if appToUninstall}
    <ConfirmDialog
      title="Uninstall {appToUninstall.name}?"
      message="Are you sure you want to uninstall {appToUninstall.name}? Application data will be removed."
      confirmText="Uninstall"
      cancelText="Cancel"
      confirmVariant="danger"
      onconfirm={confirmUninstall}
      oncancel={() => (appToUninstall = null)}
    />
  {/if}
</div>
