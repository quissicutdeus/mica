<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    appStorageBytes,
    ChevronRightIcon,
    SettingsSection,
    useAppRegistry,
    useLocale,
    AppIconTile,
    type AppManifest
  } from '@mica/sdk';

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

  const { t } = useLocale();
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
    if (bytes === 0) return $t('settings.apps.noStoredData');
    if (bytes < 1024) return $t('settings.apps.bytesStored', { bytes });
    return $t('settings.apps.kilobytesStored', { kilobytes: (bytes / 1024).toFixed(1) });
  };
</script>

{#snippet group(heading: string, apps: AppManifest[], note: string)}
  {#if apps.length > 0}
    <SettingsSection title={heading} footer={note}>
      <div class="divide-outline-variant text-body-medium divide-y">
        {#each apps as app (app.id)}
          <button
            type="button"
            onclick={() => onselect(app.id)}
            class="hover:bg-surface-container-hover active:bg-surface-container-pressed duration-short ease-standard flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors"
          >
            <AppIconTile name={app.name} icon={app.icon} color={app.color} size="sm" />
            <div class="min-w-0 flex-1">
              <span class="text-on-surface block truncate font-medium">{app.name}</span>
              <span class="text-on-surface-variant text-body-small block truncate"
                >{sizeOf(app)}</span
              >
            </div>
            <ChevronRightIcon class="text-on-surface-variant size-icon-sm shrink-0" />
          </button>
        {/each}
      </div>
    </SettingsSection>
  {/if}
{/snippet}

<div class="space-y-6 p-4">
  {@render group($t('settings.apps.system'), system, $t('settings.apps.systemNote'))}
  {@render group($t('settings.apps.addOns'), addOns, $t('settings.apps.addOnsNote'))}
</div>
