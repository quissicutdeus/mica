<script lang="ts">
  import {
    useAppRegistry,
    useNavigation,
    type AppManifest,
    ConfirmDialog,
    Screen,
    SegmentedControl,
    useAppAction,
    type AppComponent,
    type AppProps,
    fetchCatalog
  } from '@gphone/sdk';
  import { mergedCatalogApps } from './appInfo';
  import AppDetails from './components/AppDetails.svelte';
  import UnavailableApp from './components/UnavailableApp.svelte';
  import CatalogList from './components/CatalogList.svelte';
  import InstalledList from './components/InstalledList.svelte';

  let { onback }: AppProps = $props();

  /**
   * The operator's own catalog server, if they have one. Unset by default: `remoteCatalogApps`
   * already returns an empty list for `undefined`, so the Store shows exactly what it showed
   * before this shipped until an operator points this at a real, allowlisted host.
   */
  const REMOTE_CATALOG_URL: string | undefined = undefined;

  // Starts empty; `mergedCatalogApps` (bundled add-ons + whatever the configured catalog
  // returns) fills it in once the effect below resolves. `catalogApps()` is not called
  // directly here any more — `mergedCatalogApps` already calls it internally.
  let catalogAppsList = $state<AppManifest[]>([]);

  $effect(() => {
    mergedCatalogApps(REMOTE_CATALOG_URL).then((apps) => (catalogAppsList = apps));
  });

  const { registryStore, unregisterApp, registerApp, installFromCatalog } = useAppRegistry();
  const { openApp: openPhoneApp } = useNavigation();
  const { run } = useAppAction('store');

  let activeTab = $state<'catalog' | 'installed'>('catalog');
  let installedFilter = $state<'all' | 'system' | 'addon'>('all');
  let installedSortOrder = $state<'newest' | 'oldest' | 'updated' | 'name'>('newest');
  let selectedApp = $state<AppManifest | null>(null);
  let appToUninstall = $state<AppManifest | null>(null);

  const isInstalled = (appId: string): boolean => $registryStore.some((a) => a.id === appId);

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

  /**
   * The registry mounts whatever it is given, so an app with no component gets a real one
   * that says so rather than `undefined`.
   *
   * This used to hand over `{ name, type }`, which is not a component: tapping the icon
   * afterwards reached `ErrorBoundary` and reported that the app had stopped working, for an
   * app that had never existed. Now that the invented catalog entries are gone, the only
   * way here is a manifest whose `index.svelte` is missing — see `UnavailableApp` itself.
   */
  const placeholderComponent = (): AppComponent => UnavailableApp;

  function handleInstall(app: AppManifest) {
    if (app.isRemote && app.bundleUrl) {
      const target = app;
      void run(
        async () => {
          const entries = await fetchCatalog(REMOTE_CATALOG_URL as string);
          const entry = entries.find((e) => e.id === target.id);
          if (!entry) throw new Error(`'${target.name}' is no longer in the catalog.`);
          await installFromCatalog(entry);
        },
        { title: 'Store', success: `${app.name} installed successfully!` }
      );
      return;
    }

    void run(
      async () => {
        // Awaited, because components load on demand: `getComponent` answers from a cache
        // that is empty until an app has been opened once, so installing a bundled add-on
        // straight from a fresh boot would have registered the "Not part of this build"
        // placeholder for an app whose code is right there.
        const component = (await registryStore.loadComponent(app.id)) ?? placeholderComponent();
        registerApp(app, component);
      },
      { title: 'Store', success: `${app.name} installed successfully!` }
    );
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
      onback={() => (selectedApp = null)}
      oninstall={handleInstall}
      onuninstall={requestUninstall}
      onopen={openPhoneApp}
    />
  {:else}
    <Screen title="Store" {onback}>
      <div class="space-y-4 p-4">
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
            onselect={(app) => (selectedApp = app)}
            oninstall={handleInstall}
            onuninstall={requestUninstall}
          />
        {:else}
          <InstalledList
            apps={filteredInstalledApps}
            bind:filter={installedFilter}
            bind:sortOrder={installedSortOrder}
            onselect={(app) => (selectedApp = app)}
            onopen={openPhoneApp}
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
