<script lang="ts">
  import { type AppManifest, formatDate, formatRelativeTime } from '@gphone/sdk';
  import { getAppStorageSize } from '../appInfo';

  /**
   * The Store's installed tab — what is on the phone, filtered and sorted.
   *
   * `filter` and `sortOrder` are bound rather than owned here so the choice survives a
   * trip into an app's details and back, which is the whole reason the Store keeps them
   * at the top level.
   */
  let {
    apps,
    filter = $bindable('all'),
    sortOrder = $bindable('newest'),
    onselect,
    onopen
  }: {
    apps: AppManifest[];
    filter: 'all' | 'system' | 'addon';
    sortOrder: 'newest' | 'oldest' | 'updated' | 'name';
    onselect: (app: AppManifest) => void;
    onopen: (id: string) => void;
  } = $props();
</script>

<!-- Installed Apps Filter & Sort Bar -->
<div class="space-y-2">
  <div class="flex items-center justify-between gap-2">
    <span class="text-on-surface-variant text-body-small tracking-wider uppercase"
      >Applications</span
    >
    <div class="text-label-small flex gap-1">
      <button
        onclick={() => (filter = 'all')}
        aria-pressed={filter === 'all'}
        class="duration-short ease-standard rounded px-2 py-0.5 transition {filter === 'all'
          ? 'bg-primary-container text-on-primary-container'
          : 'bg-surface-container text-on-surface-variant'}"
      >
        All
      </button>
      <button
        onclick={() => (filter = 'system')}
        aria-pressed={filter === 'system'}
        class="duration-short ease-standard rounded px-2 py-0.5 transition {filter === 'system'
          ? 'bg-primary-container text-on-primary-container'
          : 'bg-surface-container text-on-surface-variant'}"
      >
        System
      </button>
      <button
        onclick={() => (filter = 'addon')}
        aria-pressed={filter === 'addon'}
        class="duration-short ease-standard rounded px-2 py-0.5 transition {filter === 'addon'
          ? 'bg-primary-container text-on-primary-container'
          : 'bg-surface-container text-on-surface-variant'}"
      >
        Add-ons
      </button>
    </div>
  </div>

  <div
    class="bg-surface-container border-outline-variant text-body-small flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5"
  >
    <span class="text-on-surface-variant text-label-small">Sort Order</span>
    <select
      bind:value={sortOrder}
      class="bg-surface-container-low border-outline-variant text-on-surface text-label-small cursor-pointer rounded border px-2 py-0.5 focus:outline-none"
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
  {#each apps as app (app.id)}
    <div
      class="bg-surface-container border-outline-variant hover:bg-surface duration-short ease-standard flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border p-3 transition"
    >
      <button
        onclick={() => onselect(app)}
        class="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg {app.color} shadow-elevation-1"
        >
          {#if typeof app.icon === 'string'}
            <img src={app.icon} alt={app.name} class="size-icon-md object-contain invert filter" />
          {:else if app.icon}
            {@const IconComp = app.icon}
            <IconComp />
          {/if}
        </div>
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
        </div>
      </button>

      <button
        onclick={() => onopen(app.id)}
        class="text-body-small duration-short ease-standard shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-white transition hover:bg-emerald-500 active:scale-95"
      >
        Open
      </button>
    </div>
  {/each}
</div>
