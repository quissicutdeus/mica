<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { AppIconTile, type AppManifest, type AppUpdate, formatDate, useLocale } from '@mica/sdk';
  import { formatPermission, getAppStorageSize } from '../appInfo';

  const { t } = useLocale();

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
    update = null,
    oninstall,
    onupdate,
    onuninstall,
    onopen,
    unavailable = null
  }: {
    app: AppManifest;
    installed: boolean;
    /** The pending update for this app, or `null` when it is current (or not a catalog install). */
    update?: AppUpdate | null;
    oninstall: (app: AppManifest) => void;
    onupdate: (app: AppManifest) => void;
    onuninstall: (app: AppManifest) => void;
    onopen: (id: string) => void;
    /** Why this server cannot install the app, or `null` (MICA-169). */
    unavailable?: string | null;
  } = $props();

  const system = $derived(app.core);
</script>

<!--
  The app's details, with no header of their own (MICA-264): `AppDetails` puts them in a
  `Screen` on the phone, and the tablet's Store shows them in its detail pane beside the
  catalog, under the one header that screen already has. A `Screen` in a pane would draw a
  second header and the status bar's inset in the middle of the frame.

  `min-h-0 flex-1` and its own scroller, so it fills whichever column it is put in.
-->
<div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
  <!-- Hero Header Box -->
  <div class="flex flex-col items-center space-y-3 pt-2 text-center">
    <AppIconTile name={app.name} icon={app.icon} color={app.color} size="xl" />

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
            class="shadow-elevation-2 text-body-small duration-short ease-standard w-full rounded-box bg-emerald-600 py-2.5 text-white transition hover:bg-emerald-500 active:scale-95"
          >
            {$t('store.openApplication')}
          </button>
          <div
            class="bg-secondary text-secondary text-label-small flex items-center justify-center gap-1.5 rounded-box border border-indigo-500/20 px-3 py-1"
          >
            <span>🔒</span>
            {$t('store.coreProtected')}
          </div>
        </div>
      {:else if installed}
        <!--
          Above Open/Uninstall rather than beside them: this is the screen that lists the
          permissions the new bundle will run with, so the player reads what they are
          accepting in the same place they accept it — the same order a first install has.
        -->
        {#if update}
          <div class="mb-2 space-y-2">
            <p
              class="bg-primary-container text-on-primary-container text-body-small rounded-box px-3 py-2"
            >
              {#if update.kind === 'newer'}
                {$t('store.versionNewer', {
                  available: update.availableVersion,
                  installed: update.installedVersion ?? ''
                })}
              {:else}
                {$t('store.versionUnordered', {
                  available: update.availableVersion,
                  installed: update.installedVersion ?? ''
                })}
              {/if}
            </p>
            <button
              onclick={() => onupdate(app)}
              class="bg-secondary text-on-secondary shadow-elevation-2 text-body-small duration-short ease-standard w-full rounded-box py-2.5 transition active:scale-95"
            >
              {$t('store.updateTo', { version: update.availableVersion })}
            </button>
          </div>
        {/if}
        <div class="flex gap-2">
          <button
            onclick={() => {
              if (app) onopen(app.id);
            }}
            class="shadow-elevation-2 text-body-small duration-short ease-standard flex-1 rounded-box bg-emerald-600 py-2.5 text-white transition hover:bg-emerald-500 active:scale-95"
          >
            {$t('store.open')}
          </button>
          <button
            onclick={() => {
              if (app) onuninstall(app);
            }}
            class="bg-error text-on-error hover:bg-error shadow-elevation-2 text-body-small duration-short ease-standard flex-1 rounded-box py-2.5 transition active:scale-95"
          >
            {$t('store.uninstall')}
          </button>
        </div>
      {:else if unavailable}
        <button
          disabled
          class="disabled:bg-disabled-container disabled:text-disabled-content text-body-small w-full disabled:cursor-not-allowed rounded-box py-2.5"
        >
          {$t('store.installApplication')}
        </button>
        <p
          data-testid="app-unavailable"
          class="text-on-surface-variant text-body-small mt-2 whitespace-pre-wrap"
        >
          {unavailable}
        </p>
      {:else}
        <button
          onclick={() => {
            if (app) oninstall(app);
          }}
          class="bg-secondary text-on-secondary hover:bg-secondary shadow-elevation-2 text-body-small duration-short ease-standard w-full rounded-box py-2.5 transition active:scale-95"
        >
          {$t('store.installApplication')}
        </button>
      {/if}
    </div>
  </div>

  <!-- Description Card -->
  <div class="space-y-1.5">
    <h4 class="text-on-surface-variant text-body-small tracking-wider uppercase">
      {$t('store.about')}
    </h4>
    <p
      class="border-outline-variant bg-surface-container text-on-surface text-body-small rounded-box border p-3 leading-relaxed"
    >
      {app.description || $t('store.noDescription')}
    </p>
  </div>

  <!-- Technical Metadata Grid -->
  <div class="space-y-1.5">
    <h4 class="text-on-surface-variant text-body-small tracking-wider uppercase">
      {$t('store.information')}
    </h4>
    <div class="text-body-small grid grid-cols-2 gap-2">
      <div class="border-outline-variant bg-surface-container rounded-box border p-3">
        <span class="text-on-surface-variant text-label-small block uppercase"
          >{$t('store.type')}</span
        >
        <span class="text-on-surface font-semibold"
          >{system ? $t('store.typeSystem') : $t('store.typeAddon')}</span
        >
      </div>
      <div class="border-outline-variant bg-surface-container rounded-box border p-3">
        <span class="text-on-surface-variant text-label-small block uppercase"
          >{$t('store.storageFootprint')}</span
        >
        <span class="text-on-surface font-semibold">{getAppStorageSize(app)}</span>
      </div>
      {#if app.installedAt}
        <div class="border-outline-variant bg-surface-container rounded-box border p-3">
          <span class="text-on-surface-variant text-label-small block uppercase"
            >{$t('store.installedDate')}</span
          >
          <span class="text-on-surface font-semibold">{formatDate(app.installedAt)}</span>
        </div>
      {/if}
      {#if app.updatedAt}
        <div class="border-outline-variant bg-surface-container rounded-box border p-3">
          <span class="text-on-surface-variant text-label-small block uppercase"
            >{$t('store.lastUpdated')}</span
          >
          <span class="text-on-surface font-semibold">{formatDate(app.updatedAt)}</span>
        </div>
      {/if}
    </div>
  </div>

  <!-- Permissions Breakdown -->
  <div class="space-y-1.5 pb-4">
    <h4 class="text-on-surface-variant text-body-small tracking-wider uppercase">
      {$t('store.permissionsRequested')}
    </h4>
    {#if (app.permissions && app.permissions.length > 0) || app.requiresNetwork}
      <div class="grid grid-cols-2 gap-2">
        {#each app.permissions ?? [] as perm (perm)}
          {@const formatted = formatPermission(perm, $t)}
          <div
            class="border-outline-variant bg-surface-container text-on-surface text-body-small flex items-center gap-2 rounded-box border px-3 py-2"
          >
            <span>{formatted.icon}</span>
            <span>{formatted.label}</span>
          </div>
        {/each}
        {#if app.requiresNetwork}
          <div
            class="border-outline-variant bg-surface-container text-on-surface text-body-small flex items-center gap-2 rounded-box border px-3 py-2"
          >
            <span>{'\u{1F310}'}</span>
            <span>{$t('store.networkAccess')}</span>
          </div>
        {/if}
      </div>
    {:else}
      <p
        class="border-outline-variant bg-surface-container text-on-surface-variant text-body-small rounded-box border p-3 italic"
      >
        {$t('store.noPermissions')}
      </p>
    {/if}
  </div>
</div>
