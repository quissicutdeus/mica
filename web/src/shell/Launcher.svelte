<script lang="ts">
  import { isAdmin } from '../services/admin';
  import AppIcon from '../sdk/ui/AppIcon.svelte';
  import { appRegistryStore } from './state/registry';

  let { openApp } = $props<{ openApp: (id: string) => void }>();

  /**
   * Apps flagged `requiresAdmin` are absent for everyone else, rather than present and
   * refusing. A visible icon that errors on tap tells a player something exists that
   * they cannot have, which is worse than not showing it.
   *
   * This is only what the launcher draws. Every privileged action behind such an app is
   * checked again on the server.
   */
  const visibleApps = $derived($appRegistryStore.filter((app) => !app.requiresAdmin || $isAdmin));
</script>

<div
  role="region"
  aria-label="Home Screen"
  class="flex h-full flex-col items-center bg-gradient-to-br from-gray-800 to-gray-900 p-4 text-white select-none"
>
  <h1 class="mb-8 text-4xl font-bold tracking-tight">gPhone</h1>

  <div class="grid w-full grid-cols-4 gap-4 px-4">
    {#each visibleApps as app}
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
