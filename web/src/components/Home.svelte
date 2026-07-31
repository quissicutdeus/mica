<script lang="ts">
  import AppIcon from './AppIcon.svelte';
  import { appRegistryStore } from '../store/registry';

  let { openApp } = $props<{ openApp: (id: string) => void }>();
</script>

<div
  role="region"
  aria-label="Home Screen"
  class="flex h-full flex-col items-center bg-gradient-to-br from-gray-800 to-gray-900 p-4 text-white select-none"
>
  <h1 class="mb-8 text-4xl font-bold tracking-tight">gPhone</h1>

  <div class="grid w-full grid-cols-4 gap-4 px-4">
    {#each $appRegistryStore as app}
      <AppIcon
        name={app.name}
        color={app.color}
        icon={app.icon}
        badgeStore={app.badgeStore}
        onclick={() => openApp(app.id)}
      />
    {/each}
  </div>
</div>
