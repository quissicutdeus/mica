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
    <span class="text-xs font-bold tracking-wider text-gray-400 uppercase">Applications</span>
    <div class="flex gap-1 text-[11px]">
      <button
        onclick={() => (filter = 'all')}
        aria-pressed={filter === 'all'}
        class="rounded px-2 py-0.5 transition {filter === 'all'
          ? 'bg-indigo-600 text-white'
          : 'bg-gray-800 text-gray-400'}"
      >
        All
      </button>
      <button
        onclick={() => (filter = 'system')}
        aria-pressed={filter === 'system'}
        class="rounded px-2 py-0.5 transition {filter === 'system'
          ? 'bg-indigo-600 text-white'
          : 'bg-gray-800 text-gray-400'}"
      >
        System
      </button>
      <button
        onclick={() => (filter = 'addon')}
        aria-pressed={filter === 'addon'}
        class="rounded px-2 py-0.5 transition {filter === 'addon'
          ? 'bg-indigo-600 text-white'
          : 'bg-gray-800 text-gray-400'}"
      >
        Add-ons
      </button>
    </div>
  </div>

  <div
    class="flex items-center justify-between gap-2 rounded-lg border border-gray-800 bg-gray-800/50 px-2.5 py-1.5 text-xs"
  >
    <span class="text-[11px] font-medium text-gray-400">Sort Order</span>
    <select
      bind:value={sortOrder}
      class="cursor-pointer rounded border border-gray-700 bg-gray-900 px-2 py-0.5 text-[11px] text-gray-200 focus:outline-none"
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
      class="flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-gray-800 bg-gray-800/40 p-3 transition hover:border-gray-700"
    >
      <button
        onclick={() => onselect(app)}
        class="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg {app.color} shadow-sm"
        >
          {#if typeof app.icon === 'string' && app.icon.startsWith('http')}
            <img src={app.icon} alt={app.name} class="h-5 w-5 object-contain invert filter" />
          {:else if typeof app.icon === 'function'}
            {@const IconComp = app.icon}
            <IconComp />
          {:else}
            <span class="text-sm font-bold text-white">{app.name.charAt(0)}</span>
          {/if}
        </div>
        <div class="min-w-0 flex-1">
          <span class="block truncate text-sm font-semibold text-white">{app.name}</span>
          <div class="flex items-center gap-1.5 truncate text-[11px] text-gray-400">
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
        class="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 active:scale-95"
      >
        Open
      </button>
    </div>
  {/each}
</div>
