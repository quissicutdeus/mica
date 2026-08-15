<script lang="ts">
  import { appStorageBytes, ChevronRightIcon, useAppRegistry, type AppManifest } from '@gphone/sdk';

  /**
   * Everything installed, system apps and Store add-ons together.
   *
   * Read straight from the registry store, which *is* the installed list — core apps are in it
   * from boot and an add-on joins on install. No second list to drift, and no filter tabs: the
   * point of this pane is management rather than browsing, and the group heading already says
   * which half a row is in.
   *
   * Deliberately not a copy of the Store's installed tab. That surface answers "what could I
   * have"; this one answers "what is on my phone and how do I reset it". The Store keeps the
   * catalog, the sort orders and the permission disclosure.
   */
  let { onselect }: { onselect: (id: string) => void } = $props();

  const { registryStore } = useAppRegistry();

  const system = $derived($registryStore.filter((app) => app.core));
  const addOns = $derived($registryStore.filter((app) => !app.core));

  /**
   * Recomputed whenever the list changes, which is enough.
   *
   * `appStorageBytes` reads the backend on call, so this is a snapshot rather than a
   * subscription — there is no store behind localStorage to react to. Clearing an app's storage
   * from the detail pane comes back through here, and re-entering the pane re-reads it.
   */
  const sizeOf = (app: AppManifest): string => {
    const bytes = appStorageBytes(app.id);
    if (bytes === 0) return 'No stored data';
    if (bytes < 1024) return `${bytes} B stored`;
    return `${(bytes / 1024).toFixed(1)} KB stored`;
  };
</script>

{#snippet group(heading: string, apps: AppManifest[], note: string)}
  {#if apps.length > 0}
    <div>
      <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
        {heading}
      </h2>
      <div
        class="divide-outline-variant bg-surface-container text-body-medium divide-y overflow-hidden rounded-xl"
      >
        {#each apps as app (app.id)}
          <button
            type="button"
            onclick={() => onselect(app.id)}
            class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors"
          >
            <div
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg {app.color} shadow-elevation-1"
            >
              {#if typeof app.icon === 'string' && app.icon.startsWith('http')}
                <img src={app.icon} alt="" class="h-5 w-5 object-contain invert filter" />
              {:else if typeof app.icon === 'function'}
                {@const IconComp = app.icon}
                <IconComp />
              {:else}
                <span class="text-on-surface text-body-medium">{app.name.charAt(0)}</span>
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <span class="text-on-surface block truncate font-medium">{app.name}</span>
              <span class="text-on-surface-variant text-body-small block truncate"
                >{sizeOf(app)}</span
              >
            </div>
            <ChevronRightIcon class="text-on-surface-variant h-4 w-4 shrink-0" />
          </button>
        {/each}
      </div>
      <p class="text-on-surface-variant text-body-small mt-1.5 px-2">{note}</p>
    </div>
  {/if}
{/snippet}

<div class="space-y-6 p-4">
  {@render group('System', system, 'Ships with the phone and cannot be uninstalled.')}
  {@render group('Add-ons', addOns, 'Installed from the Store, and removable from here or there.')}
</div>
