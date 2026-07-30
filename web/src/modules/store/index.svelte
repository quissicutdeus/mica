<script lang="ts">
  import {
    useAppRegistry,
    usePhoneNotification,
    type AppManifest,
    type AppPermission,
  } from "@gphone/sdk";

  let { onback } = $props<{ onback?: () => void }>();

  const { registryStore, unregisterApp, registerApp } = useAppRegistry();
  const { sendNotification } = usePhoneNotification();

  let activeTab = $state<"catalog" | "installed">("catalog");
  let installedFilter = $state<"all" | "system" | "addon">("all");
  let selectedApp = $state<AppManifest | null>(null);

  // Available community catalog apps (sorted alphabetically by name)
  const catalogApps: AppManifest[] = [
    {
      id: "chirper_social",
      name: "Chirper",
      color: "bg-sky-500",
      icon: "https://raw.githubusercontent.com/feathericons/feather/master/icons/twitter.svg",
      version: "2.0.1",
      author: "Chirper Media Inc.",
      description:
        "Social media networking app to post updates, photos, and follow friends.",
      permissions: ["notifications", "media", "network", "storage"],
      isRemote: true,
    },
    {
      id: "crypto_tracker",
      name: "Crypto Tracker",
      color: "bg-amber-500",
      icon: "https://raw.githubusercontent.com/feathericons/feather/master/icons/trending-up.svg",
      version: "1.2.0",
      author: "Satoshi Labs",
      description:
        "Real-time cryptocurrency prices, portfolio tracking, and market analytics.",
      permissions: ["network", "storage"],
      isRemote: true,
    },
    {
      id: "taxi_share",
      name: "Downtown Taxi",
      color: "bg-yellow-500",
      icon: "https://raw.githubusercontent.com/feathericons/feather/master/icons/navigation.svg",
      version: "1.0.4",
      author: "Los Santos Transit",
      description:
        "Order rides, track cab locations, and pay fares directly from your phone.",
      permissions: ["location", "network", "notifications"],
      isRemote: true,
    },
    {
      id: "marketplace_app",
      name: "Marketplace",
      color: "bg-emerald-600",
      icon: "https://raw.githubusercontent.com/feathericons/feather/master/icons/shopping-bag.svg",
      version: "1.1.0",
      author: "Community Trade",
      description: "Peer-to-peer marketplace to buy, sell, and auction items.",
      permissions: ["contacts", "notifications", "storage", "network"],
      isRemote: true,
    },
    {
      id: "notes",
      name: "Notes",
      color: "bg-yellow-400",
      icon: "https://raw.githubusercontent.com/feathericons/feather/master/icons/file-text.svg",
      version: "1.0.0",
      author: "Community",
      description: "Create and store personal notes",
      permissions: ["storage"],
      isSystem: false,
    },
  ];

  // Map permission key to human readable text and icon
  function formatPermission(perm: AppPermission): {
    label: string;
    icon: string;
  } {
    switch (perm) {
      case "notifications":
        return { label: "Notifications", icon: "🔔" };
      case "contacts":
        return { label: "Contacts Access", icon: "📇" };
      case "camera":
        return { label: "Camera Access", icon: "📷" };
      case "media":
        return { label: "Photos & Media", icon: "🖼️" };
      case "storage":
        return { label: "Local Storage", icon: "💾" };
      case "location":
        return { label: "Location Services", icon: "📍" };
      case "network":
        return { label: "Network Access", icon: "🌐" };
      default:
        return { label: perm, icon: "⚙️" };
    }
  }

  // Estimated storage size calculation helper
  function getAppStorageSize(app: AppManifest): string {
    if (isSystemApp(app)) {
      return "System Protected";
    }
    // Simple deterministic size estimation based on app properties
    const length =
      (app.id.length + app.name.length + (app.permissions?.length || 0)) * 85;
    return `${(length / 10).toFixed(0)} KB`;
  }

  // Check if an app is installed
  function isInstalled(appId: string): boolean {
    return $registryStore.some((a) => a.id === appId);
  }

  // Check if app is a system app
  function isSystemApp(app: AppManifest): boolean {
    if (app.isSystem === false) return false;
    return !app.isRemote && (app.author === "gPhone" || !app.author);
  }

  // Filtered installed apps
  const filteredInstalledApps = $derived(
    $registryStore.filter((app) => {
      if (installedFilter === "system") return isSystemApp(app);
      if (installedFilter === "addon") return !isSystemApp(app);
      return true;
    }),
  );

  // Simple mock component for dynamically installed catalog apps
  function createCatalogMockComponent(appName: string) {
    return {
      name: appName,
      type: "CatalogMockApp",
    };
  }

  function handleInstall(app: AppManifest) {
    try {
      const component =
        registryStore.getComponent(app.id) ||
        createCatalogMockComponent(app.name);
      registerApp(app, component);
      sendNotification({
        title: "Store",
        message: `${app.name} installed successfully!`,
        type: "success",
      });
    } catch (err: any) {
      sendNotification({
        title: "Installation Error",
        message: err.message || "Failed to install app",
        type: "error",
      });
    }
  }

  function handleUninstall(app: AppManifest) {
    try {
      unregisterApp(app.id);
      sendNotification({
        title: "Store",
        message: `${app.name} uninstalled`,
        type: "info",
      });
      if (selectedApp?.id === app.id) {
        selectedApp = null;
      }
    } catch (err: any) {
      sendNotification({
        title: "Uninstall Error",
        message: err.message || "Failed to uninstall app",
        type: "error",
      });
    }
  }
</script>

<div
  class="flex h-full w-full flex-col bg-gray-900 text-white selection:bg-indigo-500 selection:text-white"
>
  <!-- Top Navigation Header -->
  <div
    class="flex items-center justify-between border-b border-gray-800 bg-gray-900/90 px-4 py-3 backdrop-blur"
  >
    <div class="flex items-center gap-2">
      {#if onback}
        <button
          onclick={onback}
          class="rounded-full p-1 text-gray-400 hover:bg-gray-800 hover:text-white active:scale-95 transition"
          aria-label="Back to Home"
        >
          <svg
            class="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
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
  <div class="flex border-b border-gray-800 bg-gray-950/60 p-1">
    <button
      onclick={() => (activeTab = "catalog")}
      class="flex-1 rounded-md py-1.5 text-xs font-medium transition class:bg-indigo-600={activeTab ===
        'catalog'} class:text-white={activeTab ===
        'catalog'} class:text-gray-400={activeTab !==
        'catalog'} class:hover:text-gray-200={activeTab !== 'catalog'}"
    >
      Store Catalog
    </button>
    <button
      onclick={() => (activeTab = "installed")}
      class="flex-1 rounded-md py-1.5 text-xs font-medium transition class:bg-indigo-600={activeTab ===
        'installed'} class:text-white={activeTab ===
        'installed'} class:text-gray-400={activeTab !==
        'installed'} class:hover:text-gray-200={activeTab !== 'installed'}"
    >
      Installed ({$registryStore.length})
    </button>
  </div>

  <!-- Main Body Content Area -->
  <div class="flex-1 overflow-y-auto p-4 space-y-4">
    {#if activeTab === "catalog"}
      <!-- Catalog Overview Section -->
      <div class="space-y-3">
        <h2 class="text-xs font-bold uppercase tracking-wider text-gray-400">
          Featured Add-on Apps
        </h2>
        <div class="grid gap-3">
          {#each catalogApps as app}
            {@const installed = isInstalled(app.id)}
            <div
              class="flex items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-800/60 p-3 hover:border-gray-700 transition"
            >
              <button
                onclick={() => (selectedApp = app)}
                class="flex flex-1 items-center gap-3 text-left min-w-0"
              >
                <div
                  class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl {app.color} shadow-sm"
                >
                  {#if typeof app.icon === "string" && app.icon.startsWith("http")}
                    <img
                      src={app.icon}
                      alt={app.name}
                      class="h-6 w-6 object-contain filter invert"
                    />
                  {:else}
                    <span class="text-lg font-bold text-white"
                      >{app.name.charAt(0)}</span
                    >
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold text-sm truncate text-white"
                      >{app.name}</span
                    >
                    <span
                      class="rounded bg-gray-700 px-1.5 py-0.5 text-[10px] text-gray-300 font-mono"
                      >v{app.version || "1.0"}</span
                    >
                  </div>
                  <p class="text-xs text-gray-400 line-clamp-1">
                    {app.description}
                  </p>
                </div>
              </button>

              {#if installed}
                <button
                  onclick={() => handleUninstall(app)}
                  class="rounded-lg bg-gray-700 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 active:scale-95 transition shrink-0"
                >
                  Installed
                </button>
              {:else}
                <button
                  onclick={() => handleInstall(app)}
                  class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 active:scale-95 transition shrink-0"
                >
                  Get
                </button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {:else if activeTab === "installed"}
      <!-- Installed Apps Filter Bar -->
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-bold uppercase tracking-wider text-gray-400"
          >Applications</span
        >
        <div class="flex gap-1 text-[11px]">
          <button
            onclick={() => (installedFilter = "all")}
            class="rounded px-2 py-0.5 transition class:bg-indigo-600={installedFilter ===
              'all'} class:text-white={installedFilter ===
              'all'} class:bg-gray-800={installedFilter !==
              'all'} class:text-gray-400={installedFilter !== 'all'}"
          >
            All
          </button>
          <button
            onclick={() => (installedFilter = "system")}
            class="rounded px-2 py-0.5 transition class:bg-indigo-600={installedFilter ===
              'system'} class:text-white={installedFilter ===
              'system'} class:bg-gray-800={installedFilter !==
              'system'} class:text-gray-400={installedFilter !== 'system'}"
          >
            System
          </button>
          <button
            onclick={() => (installedFilter = "addon")}
            class="rounded px-2 py-0.5 transition class:bg-indigo-600={installedFilter ===
              'addon'} class:text-white={installedFilter ===
              'addon'} class:bg-gray-800={installedFilter !==
              'addon'} class:text-gray-400={installedFilter !== 'addon'}"
          >
            Add-ons
          </button>
        </div>
      </div>

      <!-- Installed Apps List -->
      <div class="grid gap-2">
        {#each filteredInstalledApps as app}
          {@const system = isSystemApp(app)}
          <div
            class="flex items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-800/40 p-3 hover:border-gray-700 transition"
          >
            <button
              onclick={() => (selectedApp = app)}
              class="flex flex-1 items-center gap-3 text-left min-w-0"
            >
              <div
                class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg {app.color} shadow-sm"
              >
                {#if typeof app.icon === "string" && app.icon.startsWith("http")}
                  <img
                    src={app.icon}
                    alt={app.name}
                    class="h-5 w-5 object-contain filter invert"
                  />
                {:else if typeof app.icon === "function"}
                  {@const IconComp = app.icon}
                  <IconComp />
                {:else}
                  <span class="text-sm font-bold text-white"
                    >{app.name.charAt(0)}</span
                  >
                {/if}
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-semibold text-sm text-white truncate"
                    >{app.name}</span
                  >
                  {#if system}
                    <span
                      class="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400"
                      >System</span
                    >
                  {:else}
                    <span
                      class="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400"
                      >Add-on</span
                    >
                  {/if}
                </div>
                <div class="flex items-center gap-2 text-[11px] text-gray-400">
                  <span>{app.author || "gPhone"}</span>
                  <span>•</span>
                  <span>{getAppStorageSize(app)}</span>
                </div>
              </div>
            </button>

            {#if !system}
              <button
                onclick={() => handleUninstall(app)}
                class="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-500/20 active:scale-95 transition shrink-0"
              >
                Uninstall
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- App Details & Permissions Inspector Modal -->
  {#if selectedApp}
    {@const system = isSystemApp(selectedApp)}
    {@const installed = isInstalled(selectedApp.id)}
    <div
      class="absolute inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm p-3"
    >
      <div
        class="w-full max-h-[85%] overflow-y-auto rounded-2xl border border-gray-700 bg-gray-900 p-4 shadow-2xl space-y-4 animate-in slide-in-from-bottom duration-200"
      >
        <!-- Header -->
        <div class="flex items-start justify-between">
          <div class="flex items-center gap-3">
            <div
              class="flex h-12 w-12 items-center justify-center rounded-xl {selectedApp.color} shadow"
            >
              {#if typeof selectedApp.icon === "string" && selectedApp.icon.startsWith("http")}
                <img
                  src={selectedApp.icon}
                  alt={selectedApp.name}
                  class="h-6 w-6 object-contain filter invert"
                />
              {:else if typeof selectedApp.icon === "function"}
                {@const IconComp = selectedApp.icon}
                <IconComp />
              {:else}
                <span class="text-xl font-bold text-white"
                  >{selectedApp.name.charAt(0)}</span
                >
              {/if}
            </div>
            <div>
              <h3 class="text-base font-bold text-white">{selectedApp.name}</h3>
              <div class="flex items-center gap-2 text-xs text-gray-400">
                <span>{selectedApp.author || "gPhone"}</span>
                <span>•</span>
                <span>v{selectedApp.version || "1.0.0"}</span>
              </div>
            </div>
          </div>
          <button
            onclick={() => (selectedApp = null)}
            class="rounded-full p-1 text-gray-400 hover:bg-gray-800 hover:text-white transition"
            aria-label="Close details modal"
          >
            <svg
              class="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <!-- Description -->
        <p
          class="text-xs text-gray-300 leading-relaxed bg-gray-800/50 p-3 rounded-lg border border-gray-800"
        >
          {selectedApp.description ||
            "No description provided for this application."}
        </p>

        <!-- Technical Metadata Grid -->
        <div class="grid grid-cols-2 gap-2 text-xs">
          <div class="rounded-lg border border-gray-800 bg-gray-800/40 p-2.5">
            <span class="text-[10px] text-gray-400 block uppercase font-medium"
              >Type</span
            >
            <span class="font-semibold text-white"
              >{system ? "Protected System App" : "Community Add-on"}</span
            >
          </div>
          <div class="rounded-lg border border-gray-800 bg-gray-800/40 p-2.5">
            <span class="text-[10px] text-gray-400 block uppercase font-medium"
              >Storage Footprint</span
            >
            <span class="font-semibold text-white"
              >{getAppStorageSize(selectedApp)}</span
            >
          </div>
        </div>

        <!-- Permissions Breakdown -->
        <div class="space-y-2">
          <h4 class="text-xs font-bold uppercase tracking-wider text-gray-400">
            Permissions Requested
          </h4>
          {#if selectedApp.permissions && selectedApp.permissions.length > 0}
            <div class="grid grid-cols-2 gap-1.5">
              {#each selectedApp.permissions as perm}
                {@const formatted = formatPermission(perm)}
                <div
                  class="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-800/40 px-2.5 py-1.5 text-xs text-gray-200"
                >
                  <span>{formatted.icon}</span>
                  <span>{formatted.label}</span>
                </div>
              {/each}
            </div>
          {:else}
            <p class="text-xs text-gray-400 italic">
              No special permissions requested.
            </p>
          {/if}
        </div>

        <!-- Actions -->
        <div class="pt-2">
          {#if system}
            <button
              disabled
              class="w-full rounded-xl bg-gray-800 py-2 text-xs font-medium text-gray-400 cursor-not-allowed border border-gray-700"
            >
              Protected System Application
            </button>
          {:else if installed}
            <button
              onclick={() => {
                if (selectedApp) handleUninstall(selectedApp);
              }}
              class="w-full rounded-xl bg-red-600 py-2 text-xs font-semibold text-white hover:bg-red-500 active:scale-95 transition"
            >
              Uninstall Application
            </button>
          {:else}
            <button
              onclick={() => {
                if (selectedApp) handleInstall(selectedApp);
              }}
              class="w-full rounded-xl bg-indigo-600 py-2 text-xs font-semibold text-white hover:bg-indigo-500 active:scale-95 transition"
            >
              Install Application
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
