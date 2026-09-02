<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    AppIconTile,
    type AppManifest,
    type AppUpdate,
    formatDate,
    formatRelativeTime,
    useLocale
  } from '@gphone/sdk';
  import { getAppStorageSize } from '../appInfo';

  const { t } = useLocale();

  /**
   * The Store's installed tab — what is on the phone, filtered and sorted.
   *
   * `filter` and `sortOrder` are bound rather than owned here so the choice survives a
   * trip into an app's details and back, which is the whole reason the Store keeps them
   * at the top level.
   */
  let {
    apps,
    updates = [],
    filter = $bindable('all'),
    sortOrder = $bindable('newest'),
    onselect,
    onopen,
    onupdate
  }: {
    apps: AppManifest[];
    /** Pending updates, whole list rather than per row — a row looks itself up below. */
    updates?: AppUpdate[];
    filter: 'all' | 'system' | 'addon';
    sortOrder: 'newest' | 'oldest' | 'updated' | 'name';
    onselect: (app: AppManifest) => void;
    onopen: (id: string) => void;
    onupdate: (app: AppManifest) => void;
  } = $props();

  const updateFor = (appId: string): AppUpdate | undefined =>
    updates.find((u) => u.appId === appId);
</script>

<!-- Installed Apps Filter & Sort Bar -->
<div class="space-y-2">
  <div class="flex items-center justify-between gap-2">
    <span class="text-on-surface-variant text-body-small tracking-wider uppercase"
      >{$t('store.applications')}</span
    >
    <div class="text-label-small flex gap-1">
      <button
        onclick={() => (filter = 'all')}
        aria-pressed={filter === 'all'}
        class="duration-short ease-standard rounded-chip px-2 py-0.5 transition {filter === 'all'
          ? 'bg-primary-container text-on-primary-container'
          : 'bg-surface-container text-on-surface-variant'}"
      >
        {$t('store.filterAll')}
      </button>
      <button
        onclick={() => (filter = 'system')}
        aria-pressed={filter === 'system'}
        class="duration-short ease-standard rounded-chip px-2 py-0.5 transition {filter === 'system'
          ? 'bg-primary-container text-on-primary-container'
          : 'bg-surface-container text-on-surface-variant'}"
      >
        {$t('store.filterSystem')}
      </button>
      <button
        onclick={() => (filter = 'addon')}
        aria-pressed={filter === 'addon'}
        class="duration-short ease-standard rounded-chip px-2 py-0.5 transition {filter === 'addon'
          ? 'bg-primary-container text-on-primary-container'
          : 'bg-surface-container text-on-surface-variant'}"
      >
        {$t('store.filterAddons')}
      </button>
    </div>
  </div>

  <div
    class="bg-surface-container border-outline-variant text-body-small flex items-center justify-between gap-2 rounded-box border px-2.5 py-1.5"
  >
    <span class="text-on-surface-variant text-label-small">{$t('store.sortOrder')}</span>
    <select
      bind:value={sortOrder}
      class="bg-surface-container-low border-outline-variant text-on-surface text-label-small cursor-pointer rounded-chip border px-2 py-0.5 focus:outline-none"
      aria-label={$t('store.sortInstalledApps')}
    >
      <option value="newest">{$t('store.sortNewest')}</option>
      <option value="oldest">{$t('store.sortOldest')}</option>
      <option value="updated">{$t('store.sortUpdated')}</option>
      <option value="name">{$t('store.sortName')}</option>
    </select>
  </div>
</div>

<!-- Installed Apps List -->
<div class="grid w-full gap-2">
  {#each apps as app (app.id)}
    {@const update = updateFor(app.id)}
    <div
      data-testid="app-row"
      class="bg-surface-container border-outline-variant hover:bg-surface duration-short ease-standard flex w-full min-w-0 items-center justify-between gap-3 rounded-box border p-3 transition"
    >
      <button
        onclick={() => onselect(app)}
        class="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <AppIconTile name={app.name} icon={app.icon} color={app.color} size="sm" />
        <div class="min-w-0 flex-1">
          <span class="text-on-surface text-body-medium block truncate">{app.name}</span>
          <div class="text-on-surface-variant text-label-small flex items-center gap-1.5 truncate">
            <span>{app.author || 'gPhone'}</span>
            <span>•</span>
            <span>{getAppStorageSize(app)}</span>
            {#if app.installedAt}
              <span>•</span>
              <span title={formatDate(app.installedAt)}>{formatRelativeTime(app.installedAt)}</span>
            {/if}
          </div>
          <!--
            The row-level half of MICA-74. The launcher badge says *something* is behind;
            this is the only place that says which app and by how much. An `unordered` update
            says the versions differ and refuses to claim which is newer — `lib/semver.ts`
            could not order them, and inventing a direction is what a string comparison did.
          -->
          {#if update}
            <span
              class="bg-primary-container text-on-primary-container text-label-small mt-1 block truncate rounded-chip px-1.5 py-0.5"
            >
              {#if update.kind === 'newer'}
                {$t('store.rowUpdateAvailable', {
                  installed: update.installedVersion ?? '',
                  available: update.availableVersion
                })}
              {:else}
                {$t('store.rowVersionDiffers', { available: update.availableVersion })}
              {/if}
            </span>
          {/if}
        </div>
      </button>

      <div class="flex shrink-0 flex-col gap-1.5">
        {#if update}
          <button
            onclick={() => onupdate(app)}
            class="bg-secondary text-on-secondary text-body-small duration-short ease-standard rounded-box px-3 py-1.5 transition active:scale-95"
          >
            {$t('store.update')}
          </button>
        {/if}
        <button
          onclick={() => onopen(app.id)}
          class="text-body-small duration-short ease-standard rounded-box bg-emerald-600 px-3 py-1.5 text-white transition hover:bg-emerald-500 active:scale-95"
        >
          {$t('store.open')}
        </button>
      </div>
    </div>
  {/each}
</div>
