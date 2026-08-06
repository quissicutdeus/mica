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
  import { catalogApps } from './appInfo';
  import AppDetails from './components/AppDetails.svelte';
  import UnavailableApp from './components/UnavailableApp.svelte';
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
   * app that had never existed. Now that the invented catalogue entries are gone, the only
   * way here is a manifest whose `index.svelte` is missing — see `UnavailableApp` itself.
   */
  const placeholderComponent = (): AppComponent => UnavailableApp;

  function handleInstall(app: AppManifest) {
    void run(
      () => {
        const component = registryStore.getComponent(app.id) || placeholderComponent();
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
    <!-- Top Navigation Header -->
    <div class="pt-safe-top border-border bg-surface-container shrink-0 border-b px-4 pb-3">
      <div class="flex items-center gap-3">
        {#if onback}
          <button
            onclick={onback}
            class="hover:bg-surface text-on-surface-variant hover:text-on-surface rounded-full p-1 transition active:scale-95"
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
    <div class="border-border bg-surface-container-low shrink-0 border-b p-1">
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
