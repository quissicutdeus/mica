<script lang="ts">
  import { type AppManifest, formatDate } from '@gphone/sdk';
  import { formatPermission, getAppStorageSize } from '../appInfo';

  /**
   * One app's full details page — permissions, storage, install state.
   *
   * A screen of its own inside the Store rather than a route, for the same reason
   * Settings' panes are: `Shell.svelte` keys resident apps on their registry id, so
   * routing a sub-screen through the registry would rebuild the whole app on every
   * drill-in.
   */
  let {
    app,
    installed,
    onback,
    oninstall,
    onuninstall,
    onopen
  }: {
    app: AppManifest;
    installed: boolean;
    onback: () => void;
    oninstall: (app: AppManifest) => void;
    onuninstall: (app: AppManifest) => void;
    onopen: (id: string) => void;
  } = $props();

  const system = $derived(app.core);
</script>

<!-- FULL APP DETAILS VIEW PAGE -->
<div class="flex h-full w-full flex-col bg-gray-900 text-white">
  <!-- Top Navigation Header -->
  <div
    class="pt-safe-top flex shrink-0 items-center justify-between border-b border-gray-800 bg-gray-900/90 px-4 pb-3 backdrop-blur"
  >
    <button
      onclick={() => onback()}
      class="flex items-center gap-1 text-xs font-semibold text-indigo-400 transition hover:text-indigo-300"
      aria-label="Back to Store"
    >
      <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
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
      <div class="flex h-20 w-20 items-center justify-center rounded-2xl {app.color} shadow-lg">
        {#if typeof app.icon === 'string' && app.icon.startsWith('http')}
          <img src={app.icon} alt={app.name} class="h-10 w-10 object-contain invert filter" />
        {:else if typeof app.icon === 'function'}
          {@const IconComp = app.icon}
          <IconComp />
        {:else}
          <span class="text-3xl font-bold text-white">{app.name.charAt(0)}</span>
        {/if}
      </div>

      <div>
        <h3 class="text-xl font-bold text-white">{app.name}</h3>
        <div class="mt-0.5 flex items-center justify-center gap-2 text-xs text-gray-400">
          <span>{app.author}</span>
          <span>•</span>
          <span>v{app.version || '1.0.0'}</span>
        </div>
      </div>

      <!-- Primary Action Buttons at Top -->
      <div class="w-full max-w-xs pt-1">
        {#if system}
          <div class="space-y-2">
            <button
              onclick={() => {
                if (app) onopen(app.id);
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
                if (app) onopen(app.id);
              }}
              class="flex-1 rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white shadow-md transition hover:bg-emerald-500 active:scale-95"
            >
              Open
            </button>
            <button
              onclick={() => {
                if (app) onuninstall(app);
              }}
              class="flex-1 rounded-xl bg-red-600/90 py-2.5 text-xs font-semibold text-white shadow-md transition hover:bg-red-500 active:scale-95"
            >
              Uninstall
            </button>
          </div>
        {:else}
          <button
            onclick={() => {
              if (app) oninstall(app);
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
        {app.description || 'No description provided for this application.'}
      </p>
    </div>

    <!-- Technical Metadata Grid -->
    <div class="space-y-1.5">
      <h4 class="text-xs font-bold tracking-wider text-gray-400 uppercase">Information</h4>
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div class="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
          <span class="block text-[10px] font-medium text-gray-400 uppercase">Type</span>
          <span class="font-semibold text-white">{system ? 'System Application' : 'Add-on'}</span>
        </div>
        <div class="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
          <span class="block text-[10px] font-medium text-gray-400 uppercase"
            >Storage Footprint</span
          >
          <span class="font-semibold text-white">{getAppStorageSize(app)}</span>
        </div>
        {#if app.installedAt}
          <div class="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
            <span class="block text-[10px] font-medium text-gray-400 uppercase">Installed Date</span
            >
            <span class="font-semibold text-white">{formatDate(app.installedAt)}</span>
          </div>
        {/if}
        {#if app.updatedAt}
          <div class="rounded-xl border border-gray-800 bg-gray-800/40 p-3">
            <span class="block text-[10px] font-medium text-gray-400 uppercase">Last Updated</span>
            <span class="font-semibold text-white">{formatDate(app.updatedAt)}</span>
          </div>
        {/if}
      </div>
    </div>

    <!-- Permissions Breakdown -->
    <div class="space-y-1.5 pb-4">
      <h4 class="text-xs font-bold tracking-wider text-gray-400 uppercase">
        Permissions Requested
      </h4>
      {#if app.permissions && app.permissions.length > 0}
        <div class="grid grid-cols-2 gap-2">
          {#each app.permissions as perm}
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
