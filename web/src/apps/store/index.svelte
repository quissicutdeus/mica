<script lang="ts">
  import {
    useAppRegistry,
    useNavigation,
    type AppManifest,
    ConfirmDialog,
    SegmentedControl,
    useAppAction,
    type AppComponent,
    type AppProps
  } from '@gphone/sdk';
  import { catalogApps, isSystemApp } from './appInfo';
  import AppDetails from './components/AppDetails.svelte';
  import CatalogList from './components/CatalogList.svelte';
  import InstalledList from './components/InstalledList.svelte';

  let { onback }: AppProps = $props();

  const { registryStore, unregisterApp, registerApp } = useAppRegistry();
  const { openApp: openPhoneApp } = useNavigation();
  const { run } = useAppAction();

  let activeTab = $state<'catalog' | 'installed'>('catalog');
  let installedFilter = $state<'all' | 'system' | 'addon'>('all');
  let installedSortOrder = $state<'newest' | 'oldest' | 'updated' | 'name'>('newest');
  let selectedApp = $state<AppManifest | null>(null);
  let appToUninstall = $state<AppManifest | null>(null);

  const isInstalled = (appId: string): boolean => $registryStore.some((a) => a.id === appId);

  const filteredInstalledApps = $derived(
    $registryStore
      .filter((app) => {
        if (installedFilter === 'system') return isSystemApp(app);
        if (installedFilter === 'addon') return !isSystemApp(app);
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
   * A demo catalog entry has no component in this repo; the registry needs something.
   *
   * The cast is load-bearing and worth reading twice: this object is not a Svelte
   * component, so installing one of the four demo apps and then tapping it renders nothing
   * useful — `ErrorBoundary` catches it. That predates `AppComponent`; the type merely
   * stopped hiding it. A real placeholder component saying "not available in this build"
   * would be the fix, and is a UX call rather than a typing one.
   */
  const createCatalogMockComponent = (appName: string) =>
    ({ name: appName, type: 'CatalogMockApp' }) as unknown as AppComponent;

  function handleInstall(app: AppManifest) {
    void run(
      () => {
        const component =
          registryStore.getComponent(app.id) || createCatalogMockComponent(app.name);
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
  class="relative flex h-full w-full flex-col overflow-hidden bg-gray-900 text-white selection:bg-indigo-500 selection:text-white"
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
    <!-- Top Navigation Header -->
    <div
      class="flex shrink-0 items-center justify-between border-b border-gray-800 bg-gray-900/90 px-4 py-3 backdrop-blur"
    >
      <div class="flex items-center gap-2">
        {#if onback}
          <button
            onclick={onback}
            class="rounded-full p-1 text-gray-400 transition hover:bg-gray-800 hover:text-white active:scale-95"
            aria-label="Back to Home"
          >
            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
        {/if}
        <h1 class="text-lg font-bold tracking-wide">Store</h1>
      </div>
    </div>

    <!-- Tab Switcher Bar -->
    <div class="shrink-0 border-b border-gray-800 bg-gray-950/60 p-1">
      <SegmentedControl
        aria-label="Store sections"
        selected={activeTab}
        onchange={(id) => (activeTab = id as 'catalog' | 'installed')}
        options={[
          { id: 'catalog', label: 'Store Catalog' },
          { id: 'installed', label: `Installed (${$registryStore.length})` }
        ]}
      />
    </div>

    <!-- Main Body Content Area -->
    <div class="flex-1 space-y-4 overflow-y-auto p-4">
      {#if activeTab === 'catalog'}
        <CatalogList
          apps={catalogApps()}
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
