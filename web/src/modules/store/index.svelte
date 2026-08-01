<script lang="ts">
  import {
    useAppRegistry,
    usePhoneNotification,
    useNavigation,
    type AppManifest,
    type AppPermission
  } from '@gphone/sdk';
  import ConfirmDialog from '../../components/ConfirmDialog.svelte';
  import { formatDate, formatRelativeTime } from '../../utils/formatters';

  let { onback } = $props<{ onback?: () => void }>();

  const { registryStore, unregisterApp, registerApp } = useAppRegistry();
  const { sendNotification } = usePhoneNotification();
  const { openApp: openPhoneApp } = useNavigation();

  let activeTab = $state<'catalog' | 'installed'>('catalog');
  let installedFilter = $state<'all' | 'system' | 'addon'>('all');
  let installedSortOrder = $state<'newest' | 'oldest' | 'updated' | 'name'>('newest');
  let selectedApp = $state<AppManifest | null>(null);
  let appToUninstall = $state<AppManifest | null>(null);

  // Available community catalog apps (sorted alphabetically by name)
  const catalogApps: AppManifest[] = [
    {
      id: 'chirper_social',
      name: 'Chirper',
      color: 'bg-sky-500',
      icon: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/twitter.svg',
      version: '2.0.1',
      author: 'Chirper Media Inc.',
      description: 'Social media networking app to post updates, photos, and follow friends.',
      permissions: ['notifications', 'media', 'network', 'storage'],
      isRemote: true
    },
    {
      id: 'crypto_tracker',
      name: 'Crypto Tracker',
      color: 'bg-amber-500',
      icon: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/trending-up.svg',
      version: '1.2.0',
      author: 'Satoshi Labs',
      description: 'Real-time cryptocurrency prices, portfolio tracking, and market analytics.',
      permissions: ['network', 'storage'],
      isRemote: true
    },
    {
      id: 'taxi_share',
      name: 'Downtown Taxi',
      color: 'bg-yellow-500',
      icon: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/navigation.svg',
      version: '1.0.4',
      author: 'Los Santos Transit',
      description: 'Order rides, track cab locations, and pay fares directly from your phone.',
      permissions: ['location', 'network', 'notifications'],
      isRemote: true
    },
    {
      id: 'marketplace_app',
      name: 'Marketplace',
      color: 'bg-emerald-600',
      icon: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/shopping-bag.svg',
      version: '1.1.0',
      author: 'Community Trade',
      description: 'Peer-to-peer marketplace to buy, sell, and auction items.',
      permissions: ['contacts', 'notifications', 'storage', 'network'],
      isRemote: true
    },
    {
      id: 'notes',
      name: 'Notes',
      color: 'bg-yellow-400',
      icon: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/file-text.svg',
      version: '1.0.0',
      author: 'Community',
      description: 'Create and store personal notes',
      permissions: ['storage'],
      isSystem: false
    }
  ];

  // Map permission key to human readable text and icon
  function formatPermission(perm: AppPermission): {
    label: string;
    icon: string;
  } {
    switch (perm) {
      case 'notifications':
        return { label: 'Notifications', icon: '🔔' };
      case 'contacts':
        return { label: 'Contacts Access', icon: '📇' };
      case 'camera':
        return { label: 'Camera Access', icon: '📷' };
      case 'media':
        return { label: 'Photos & Media', icon: '🖼️' };
      case 'storage':
        return { label: 'Local Storage', icon: '💾' };
      case 'location':
        return { label: 'Location Services', icon: '📍' };
      case 'network':
        return { label: 'Network Access', icon: '🌐' };
      default:
        return { label: perm, icon: '⚙️' };
    }
  }

  // Estimated storage size calculation helper
  function getAppStorageSize(app: AppManifest): string {
    if (isSystemApp(app)) {
      return 'System Protected';
    }
    // Simple deterministic size estimation based on app properties
    const length = (app.id.length + app.name.length + (app.permissions?.length || 0)) * 85;
    return `${(length / 10).toFixed(0)} KB`;
  }

  // Check if an app is installed
  function isInstalled(appId: string): boolean {
    return $registryStore.some((a) => a.id === appId);
  }

  // Check if app is a system app
  function isSystemApp(app: AppManifest): boolean {
    if (app.isSystem === false) return false;
    return !app.isRemote && (app.author === 'gPhone' || !app.author);
  }

  // Filtered and sorted installed apps
  const filteredInstalledApps = $derived(
    $registryStore
      .filter((app) => {
        if (installedFilter === 'system') return isSystemApp(app);
        if (installedFilter === 'addon') return !isSystemApp(app);
        return true;
      })
      .slice()
      .sort((a, b) => {
        if (installedSortOrder === 'name') {
          return a.name.localeCompare(b.name);
        }
        const timeA_inst = a.installedAt ? new Date(a.installedAt).getTime() : 0;
        const timeB_inst = b.installedAt ? new Date(b.installedAt).getTime() : 0;
        const timeA_upd = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const timeB_upd = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;

        if (installedSortOrder === 'oldest') {
          return timeA_inst - timeB_inst || a.name.localeCompare(b.name);
        }
        if (installedSortOrder === 'updated') {
          return timeB_upd - timeA_upd || a.name.localeCompare(b.name);
        }
        // default: newest installed first
        return timeB_inst - timeA_inst || a.name.localeCompare(b.name);
      })
  );

  // Simple mock component for dynamically installed catalog apps
  function createCatalogMockComponent(appName: string) {
    return {
      name: appName,
      type: 'CatalogMockApp'
    };
  }

  function handleInstall(app: AppManifest) {
    try {
      const component = registryStore.getComponent(app.id) || createCatalogMockComponent(app.name);
      registerApp(app, component);
      sendNotification({
        title: 'Store',
        message: `${app.name} installed successfully!`,
        type: 'success'
      });
    } catch (err: any) {
      sendNotification({
        title: 'Installation Error',
        message: err.message || 'Failed to install app',
        type: 'error'
      });
    }
  }

  function requestUninstall(app: AppManifest) {
    appToUninstall = app;
  }

  function confirmUninstall() {
    if (!appToUninstall) return;
    const targetApp = appToUninstall;
    appToUninstall = null;
    handleUninstall(targetApp);
  }

  function handleUninstall(app: AppManifest) {
    try {
      unregisterApp(app.id);
      sendNotification({
        title: 'Store',
        message: `${app.name} uninstalled`,
        type: 'info'
      });
      if (selectedApp?.id === app.id) {
        selectedApp = null;
      }
    } catch (err: any) {
      sendNotification({
        title: 'Uninstall Error',
        message: err.message || 'Failed to uninstall app',
        type: 'error'
      });
    }
  }
</script>

<div
  class="relative flex h-full w-full flex-col overflow-hidden bg-gray-900 text-white selection:bg-indigo-500 selection:text-white"
>
  {#if selectedApp}
    <!-- FULL APP DETAILS VIEW PAGE -->
    {@const system = isSystemApp(selectedApp)}
    {@const installed = isInstalled(selectedApp.id)}
    <div class="flex h-full w-full flex-col bg-gray-900 text-white">
      <!-- Top Navigation Header -->
      <div
        class="flex shrink-0 items-center justify-between border-b border-gray-800 bg-gray-900/90 px-4 py-3 backdrop-blur"
      >
        <button
          onclick={() => (selectedApp = null)}
          class="flex items-center gap-1 text-xs font-semibold text-indigo-400 transition hover:text-indigo-300"
          aria-label="Back to Store"
        >
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Back
        </button>
        <span class="text-xs font-bold tracking-wider text-gray-400 uppercase"> App Details </span>
        <div class="w-10"></div>
      </div>

      <!-- App Details Page Body -->
      <div class="flex-1 space-y-5 overflow-y-auto p-4">
        <!-- Hero Header Box -->
        <div class="flex flex-col items-center space-y-3 pt-2 text-center">
          <div
            class="flex h-20 w-20 items-center justify-center rounded-2xl {selectedApp.color} shadow-lg"
          >
            {#if typeof selectedApp.icon === 'string' && selectedApp.icon.startsWith('http')}
              <img
                src={selectedApp.icon}
                alt={selectedApp.name}
                class="h-10 w-10 object-contain invert filter"
              />
            {:else if typeof selectedApp.icon === 'function'}
              {@const IconComp = selectedApp.icon}
              <IconComp />
            {:else}
              <span class="text-3xl font-bold text-white">{selectedApp.name.charAt(0)}</span>
            {/if}
          </div>

          <div>
            <h3 class="text-xl font-bold text-white">{selectedApp.name}</h3>
            <div class="mt-0.5 flex items-center justify-center gap-2 text-xs text-gray-400">
              <span>{selectedApp.author || 'gPhone'}</span>
              <span>•</span>
              <span>v{selectedApp.version || '1.0.0'}</span>
            </div>
          </div>

          <!-- Primary Action Buttons at Top -->
          <div class="w-full max-w-xs pt-1">
            {#if system}
              <div class="space-y-2">
                <button
                  onclick={() => {
                    if (selectedApp) openPhoneApp(selectedApp.id);
                  }}
                  class="w-full rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white shadow-md transition hover:bg-emerald-500 active:scale-95"
                >
                  Open Application
                </button>
                <div
                  class="flex items-center justify-center gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-1 text-[11px] font-medium text-indigo-300"
                >
                  <span>🔒</span> Core System App — protected from removal
                </div>
              </div>
            {:else if installed}
              <div class="flex gap-2">
                <button
                  onclick={() => {
                    if (selectedApp) openPhoneApp(selectedApp.id);
                  }}
                  class="flex-1 rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white shadow-md transition hover:bg-emerald-500 active:scale-95"
                >
                  Open
                </button>
                <button
                  onclick={() => {
                    if (selectedApp) requestUninstall(selectedApp);
                  }}
                  class="flex-1 rounded-xl bg-red-600/90 py-2.5 text-xs font-semibold text-white shadow-md transition hover:bg-red-500 active:scale-95"
                >
                  Uninstall
                </button>
              </div>
            {:else}
              <button
                onclick={() => {
                  if (selectedApp) handleInstall(selectedApp);
                }}
                class="w-full rounded-xl bg-indigo-600 py-2.5 text-xs font-semibold text-white shadow-md transition hover:bg-indigo-500 active:scale-95"
              >
                Install Application
              </button>
            {/if}
          </div>
        </div>

        <!-- Description Card -->
        <div class="space-y-1.5">
          <h4 class="text-xs font-bold tracking-wider text-gray-400 uppercase">About</h4>
          <p
            class="rounded-xl border border-gray-800 bg-gray-800/60 p-3 text-xs leading-relaxed text-gray-300"
          >
            {selectedApp.description || 'No description provided for this application.'}
          </p>
        </div>

        <!-- Technical Metadata Grid -->
        <div class="space-y-1.5">
          <h4 class="text-xs font-bold tracking-wider text-gray-400 uppercase">Information</h4>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
              <span class="block text-[10px] font-medium text-gray-400 uppercase">Type</span>
              <span class="font-semibold text-white"
                >{system ? 'System Application' : 'Community Add-on'}</span
              >
            </div>
            <div class="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
              <span class="block text-[10px] font-medium text-gray-400 uppercase"
                >Storage Footprint</span
              >
              <span class="font-semibold text-white">{getAppStorageSize(selectedApp)}</span>
            </div>
            {#if selectedApp.installedAt}
              <div class="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
                <span class="block text-[10px] font-medium text-gray-400 uppercase"
                  >Installed Date</span
                >
                <span class="font-semibold text-white">{formatDate(selectedApp.installedAt)}</span>
              </div>
            {/if}
            {#if selectedApp.updatedAt}
              <div class="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
                <span class="block text-[10px] font-medium text-gray-400 uppercase"
                  >Last Updated</span
                >
                <span class="font-semibold text-white">{formatDate(selectedApp.updatedAt)}</span>
              </div>
            {/if}
          </div>
        </div>

        <!-- Permissions Breakdown -->
        <div class="space-y-1.5 pb-4">
          <h4 class="text-xs font-bold tracking-wider text-gray-400 uppercase">
            Permissions Requested
          </h4>
          {#if selectedApp.permissions && selectedApp.permissions.length > 0}
            <div class="grid grid-cols-2 gap-2">
              {#each selectedApp.permissions as perm}
                {@const formatted = formatPermission(perm)}
                <div
                  class="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-2 text-xs text-gray-200"
                >
                  <span>{formatted.icon}</span>
                  <span>{formatted.label}</span>
                </div>
              {/each}
            </div>
          {:else}
            <p
              class="rounded-xl border border-gray-800 bg-gray-800/40 p-3 text-xs text-gray-400 italic"
            >
              No special permissions requested.
            </p>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <!-- MAIN STORE CATALOG & INSTALLED LIST VIEW -->
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
    <div class="flex shrink-0 border-b border-gray-800 bg-gray-950/60 p-1">
      <button
        onclick={() => (activeTab = 'catalog')}
        class="flex-1 rounded-md py-1.5 text-xs font-medium transition class:bg-indigo-600={activeTab ===
          'catalog'} class:text-white={activeTab === 'catalog'} class:text-gray-400={activeTab !==
          'catalog'} class:hover:text-gray-200={activeTab !== 'catalog'}"
      >
        Store Catalog
      </button>
      <button
        onclick={() => (activeTab = 'installed')}
        class="flex-1 rounded-md py-1.5 text-xs font-medium transition class:bg-indigo-600={activeTab ===
          'installed'} class:text-white={activeTab ===
          'installed'} class:text-gray-400={activeTab !==
          'installed'} class:hover:text-gray-200={activeTab !== 'installed'}"
      >
        Installed ({$registryStore.length})
      </button>
    </div>

    <!-- Main Body Content Area -->
    <div class="flex-1 space-y-4 overflow-y-auto p-4">
      {#if activeTab === 'catalog'}
        <!-- Catalog Overview Section -->
        <div class="space-y-3">
          <h2 class="text-xs font-bold tracking-wider text-gray-400 uppercase">
            Featured Add-on Apps
          </h2>
          <div class="grid w-full gap-3">
            {#each catalogApps as app}
              {@const installed = isInstalled(app.id)}
              <div
                class="flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-800/60 p-3 transition hover:border-gray-700"
              >
                <button
                  onclick={() => (selectedApp = app)}
                  class="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <div
                    class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl {app.color} shadow-sm"
                  >
                    {#if typeof app.icon === 'string' && app.icon.startsWith('http')}
                      <img
                        src={app.icon}
                        alt={app.name}
                        class="h-6 w-6 object-contain invert filter"
                      />
                    {:else}
                      <span class="text-lg font-bold text-white">{app.name.charAt(0)}</span>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-sm font-semibold text-white">{app.name}</span>
                      <span
                        class="shrink-0 rounded bg-gray-700 px-1.5 py-0.5 font-mono text-[10px] text-gray-300"
                        >v{app.version || '1.0'}</span
                      >
                    </div>
                    <p class="line-clamp-1 text-xs text-gray-400">
                      {app.description}
                    </p>
                  </div>
                </button>

                {#if installed}
                  <!-- Uninstall, not Open: this column is the install control for every
                       other row, so an "Open" here reads as a different kind of action.
                       Tapping the row itself still opens the details view. -->
                  <button
                    onclick={() => requestUninstall(app)}
                    class="shrink-0 rounded-lg bg-red-600/90 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500 active:scale-95"
                  >
                    Uninstall
                  </button>
                {:else}
                  <button
                    onclick={() => handleInstall(app)}
                    class="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 active:scale-95"
                  >
                    Install
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {:else if activeTab === 'installed'}
        <!-- Installed Apps Filter & Sort Bar -->
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-bold tracking-wider text-gray-400 uppercase"
              >Applications</span
            >
            <div class="flex gap-1 text-[11px]">
              <button
                onclick={() => (installedFilter = 'all')}
                class="rounded px-2 py-0.5 transition class:bg-indigo-600={installedFilter ===
                  'all'} class:text-white={installedFilter ===
                  'all'} class:bg-gray-800={installedFilter !==
                  'all'} class:text-gray-400={installedFilter !== 'all'}"
              >
                All
              </button>
              <button
                onclick={() => (installedFilter = 'system')}
                class="rounded px-2 py-0.5 transition class:bg-indigo-600={installedFilter ===
                  'system'} class:text-white={installedFilter ===
                  'system'} class:bg-gray-800={installedFilter !==
                  'system'} class:text-gray-400={installedFilter !== 'system'}"
              >
                System
              </button>
              <button
                onclick={() => (installedFilter = 'addon')}
                class="rounded px-2 py-0.5 transition class:bg-indigo-600={installedFilter ===
                  'addon'} class:text-white={installedFilter ===
                  'addon'} class:bg-gray-800={installedFilter !==
                  'addon'} class:text-gray-400={installedFilter !== 'addon'}"
              >
                Add-ons
              </button>
            </div>
          </div>

          <div
            class="flex items-center justify-between gap-2 rounded-lg border border-gray-800 bg-gray-800/50 px-2.5 py-1.5 text-xs"
          >
            <span class="text-[11px] font-medium text-gray-400">Sort Order</span>
            <select
              bind:value={installedSortOrder}
              class="cursor-pointer rounded border border-gray-700 bg-gray-900 px-2 py-0.5 text-[11px] text-gray-200 focus:outline-none"
              aria-label="Sort Installed Apps"
            >
              <option value="newest">Newest Installed</option>
              <option value="oldest">Oldest Installed</option>
              <option value="updated">Recently Updated</option>
              <option value="name">Name (A-Z)</option>
            </select>
          </div>
        </div>

        <!-- Installed Apps List -->
        <div class="grid w-full gap-2">
          {#each filteredInstalledApps as app}
            <div
              class="flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-800/40 p-3 transition hover:border-gray-700"
            >
              <button
                onclick={() => (selectedApp = app)}
                class="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <div
                  class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg {app.color} shadow-sm"
                >
                  {#if typeof app.icon === 'string' && app.icon.startsWith('http')}
                    <img
                      src={app.icon}
                      alt={app.name}
                      class="h-5 w-5 object-contain invert filter"
                    />
                  {:else if typeof app.icon === 'function'}
                    {@const IconComp = app.icon}
                    <IconComp />
                  {:else}
                    <span class="text-sm font-bold text-white">{app.name.charAt(0)}</span>
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-semibold text-white">{app.name}</span>
                  <div class="flex items-center gap-1.5 truncate text-[11px] text-gray-400">
                    <span>{app.author || 'gPhone'}</span>
                    <span>•</span>
                    <span>{getAppStorageSize(app)}</span>
                    {#if app.installedAt}
                      <span>•</span>
                      <span title={formatDate(app.installedAt)}
                        >{formatRelativeTime(app.installedAt)}</span
                      >
                    {/if}
                  </div>
                </div>
              </button>

              <button
                onclick={() => openPhoneApp(app.id)}
                class="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 active:scale-95"
              >
                Open
              </button>
            </div>
          {/each}
        </div>
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
