<script lang="ts">
  import type { AppManifest } from '@gphone/sdk';

  /**
   * The Store's catalog tab — every add-on on offer, installed or not.
   *
   * Split out of `index.svelte` at six hundred lines, where the catalog list, the
   * installed list and the detail page were three unrelated screens sharing a file.
   */
  let {
    apps,
    isInstalled,
    onselect,
    oninstall,
    onuninstall
  }: {
    apps: AppManifest[];
    isInstalled: (id: string) => boolean;
    onselect: (app: AppManifest) => void;
    oninstall: (app: AppManifest) => void;
    onuninstall: (app: AppManifest) => void;
  } = $props();
</script>

<!-- Catalog Overview Section -->
<div class="space-y-3">
  <h2 class="text-xs font-bold tracking-wider text-gray-400 uppercase">Featured Add-on Apps</h2>
  <div class="grid w-full gap-3">
    {#each apps as app (app.id)}
      {@const installed = isInstalled(app.id)}
      <div
        class="flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-800/60 p-3 transition hover:border-gray-700"
      >
        <button
          onclick={() => onselect(app)}
          class="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl {app.color} shadow-sm"
          >
            {#if typeof app.icon === 'string' && app.icon.startsWith('http')}
              <img src={app.icon} alt={app.name} class="h-6 w-6 object-contain invert filter" />
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
            onclick={() => onuninstall(app)}
            class="shrink-0 rounded-lg bg-red-600/90 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500 active:scale-95"
          >
            Uninstall
          </button>
        {:else}
          <button
            onclick={() => oninstall(app)}
            class="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 active:scale-95"
          >
            Install
          </button>
        {/if}
      </div>
    {/each}
  </div>
</div>
