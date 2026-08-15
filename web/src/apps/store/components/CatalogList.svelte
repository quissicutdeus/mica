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
  <h2 class="text-on-surface-variant text-body-small tracking-wider uppercase">
    Featured Add-on Apps
  </h2>
  <div class="grid w-full gap-3">
    {#each apps as app (app.id)}
      {@const installed = isInstalled(app.id)}
      <div
        class="bg-surface-container border-outline-variant hover:bg-surface flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border p-3 transition"
      >
        <button
          onclick={() => onselect(app)}
          class="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl {app.color} shadow-elevation-1"
          >
            {#if typeof app.icon === 'string' && app.icon.startsWith('http')}
              <img
                src={app.icon}
                alt={app.name}
                class="size-icon-lg object-contain invert filter"
              />
            {:else}
              <span class="text-on-surface text-lg font-bold">{app.name.charAt(0)}</span>
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-on-surface text-body-medium truncate">{app.name}</span>
              <span
                class="bg-surface-container-high text-on-surface text-label-small shrink-0 rounded px-1.5 py-0.5 font-mono"
                >v{app.version || '1.0'}</span
              >
            </div>
            <p class="text-on-surface-variant text-body-small line-clamp-1">
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
            class="bg-error text-on-error hover:bg-error text-body-small shrink-0 rounded-lg px-3 py-1.5 transition active:scale-95"
          >
            Uninstall
          </button>
        {:else}
          <button
            onclick={() => oninstall(app)}
            class="bg-secondary text-on-secondary hover:bg-secondary text-body-small shrink-0 rounded-lg px-3 py-1.5 transition active:scale-95"
          >
            Install
          </button>
        {/if}
      </div>
    {/each}
  </div>
</div>
