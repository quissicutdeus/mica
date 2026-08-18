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
<div class="bg-surface text-on-surface flex h-full w-full flex-col">
  <!-- Top Navigation Header -->
  <div
    class="pt-safe-top border-outline-variant bg-surface flex shrink-0 items-center justify-between border-b px-4 pb-3 backdrop-blur"
  >
    <button
      onclick={() => onback()}
      class="text-secondary hover:text-secondary text-body-small duration-short ease-standard flex items-center gap-1 transition"
      aria-label="Back to Store"
    >
      <svg class="size-icon-sm" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
      </svg>
      Back
    </button>
    <span class="text-on-surface-variant text-body-small tracking-wider uppercase">
      App Details
    </span>
    <div class="w-10"></div>
  </div>

  <!-- App Details Page Body -->
  <div class="flex-1 space-y-5 overflow-y-auto p-4">
    <!-- Hero Header Box -->
    <div class="flex flex-col items-center space-y-3 pt-2 text-center">
      <div
        class="flex h-20 w-20 items-center justify-center rounded-lg {app.color} shadow-elevation-3"
      >
        {#if typeof app.icon === 'string'}
          <img src={app.icon} alt={app.name} class="h-10 w-10 object-contain invert filter" />
        {:else if app.icon}
          {@const IconComp = app.icon}
          <IconComp />
        {/if}
      </div>

      <div>
        <h3 class="text-on-surface text-xl font-semibold">{app.name}</h3>
        <div
          class="text-on-surface-variant text-body-small mt-0.5 flex items-center justify-center gap-2"
        >
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
              class="shadow-elevation-2 text-body-small duration-short ease-standard w-full rounded-xl bg-emerald-600 py-2.5 text-white transition hover:bg-emerald-500 active:scale-95"
            >
              Open Application
            </button>
            <div
              class="bg-secondary text-secondary text-label-small flex items-center justify-center gap-1.5 rounded-lg border border-indigo-500/20 px-3 py-1"
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
              class="shadow-elevation-2 text-body-small duration-short ease-standard flex-1 rounded-xl bg-emerald-600 py-2.5 text-white transition hover:bg-emerald-500 active:scale-95"
            >
              Open
            </button>
            <button
              onclick={() => {
                if (app) onuninstall(app);
              }}
              class="bg-error text-on-error hover:bg-error shadow-elevation-2 text-body-small duration-short ease-standard flex-1 rounded-xl py-2.5 transition active:scale-95"
            >
              Uninstall
            </button>
          </div>
        {:else}
          <button
            onclick={() => {
              if (app) oninstall(app);
            }}
            class="bg-secondary text-on-secondary hover:bg-secondary shadow-elevation-2 text-body-small duration-short ease-standard w-full rounded-xl py-2.5 transition active:scale-95"
          >
            Install Application
          </button>
        {/if}
      </div>
    </div>

    <!-- Description Card -->
    <div class="space-y-1.5">
      <h4 class="text-on-surface-variant text-body-small tracking-wider uppercase">About</h4>
      <p
        class="border-outline-variant bg-surface-container text-on-surface text-body-small rounded-xl border p-3 leading-relaxed"
      >
        {app.description || 'No description provided for this application.'}
      </p>
    </div>

    <!-- Technical Metadata Grid -->
    <div class="space-y-1.5">
      <h4 class="text-on-surface-variant text-body-small tracking-wider uppercase">Information</h4>
      <div class="text-body-small grid grid-cols-2 gap-2">
        <div class="border-outline-variant bg-surface-container rounded-xl border p-3">
          <span class="text-on-surface-variant text-label-small block uppercase">Type</span>
          <span class="text-on-surface font-semibold"
            >{system ? 'System Application' : 'Add-on'}</span
          >
        </div>
        <div class="border-outline-variant bg-surface-container rounded-xl border p-3">
          <span class="text-on-surface-variant text-label-small block uppercase"
            >Storage Footprint</span
          >
          <span class="text-on-surface font-semibold">{getAppStorageSize(app)}</span>
        </div>
        {#if app.installedAt}
          <div class="border-outline-variant bg-surface-container rounded-xl border p-3">
            <span class="text-on-surface-variant text-label-small block uppercase"
              >Installed Date</span
            >
            <span class="text-on-surface font-semibold">{formatDate(app.installedAt)}</span>
          </div>
        {/if}
        {#if app.updatedAt}
          <div class="border-outline-variant bg-surface-container rounded-xl border p-3">
            <span class="text-on-surface-variant text-label-small block uppercase"
              >Last Updated</span
            >
            <span class="text-on-surface font-semibold">{formatDate(app.updatedAt)}</span>
          </div>
        {/if}
      </div>
    </div>

    <!-- Permissions Breakdown -->
    <div class="space-y-1.5 pb-4">
      <h4 class="text-on-surface-variant text-body-small tracking-wider uppercase">
        Permissions Requested
      </h4>
      {#if app.permissions && app.permissions.length > 0}
        <div class="grid grid-cols-2 gap-2">
          {#each app.permissions as perm}
            {@const formatted = formatPermission(perm)}
            <div
              class="border-outline-variant bg-surface-container text-on-surface text-body-small flex items-center gap-2 rounded-xl border px-3 py-2"
            >
              <span>{formatted.icon}</span>
              <span>{formatted.label}</span>
            </div>
          {/each}
        </div>
      {:else}
        <p
          class="border-outline-variant bg-surface-container text-on-surface-variant text-body-small rounded-xl border p-3 italic"
        >
          No special permissions requested.
        </p>
      {/if}
    </div>
  </div>
</div>
