<script lang="ts">
  import { EmptyState, Screen, useAppLevels, type AppProps,
  Skeleton,
  onAppForeground,
  useMarketplace } from '@gphone/sdk';

  // The annotation, not `$props<AppProps>()` — that form only works for an inline object
  // literal and reports "Expected 0 type arguments" for a named type.
  let { onback }: AppProps = $props();

  const { marketplace } = useMarketplace();
  const loaded = marketplace.loaded;

  // Every visit, not once per session — apps stay resident (AGENTS.md §11).
  onAppForeground('marketplace', () => {
    void marketplace.load();
  });

  // Declaring the levels is what claims the Back key. Add a rung per screen, deepest
  // first; with none, Back simply leaves the app. `appId` is what keeps the claim
  // pointed at this app while it sits resident in the background.
  const app = useAppLevels({
    appId: 'marketplace',
    title: 'Marketplace',
    onback: () => onback(),
    levels: []
  });
</script>

<Screen title={app.title} onback={app.back}>
  <div class="p-4">
    {#if !$loaded}
      <Skeleton count={4} height="h-14" />
    {:else if $marketplace.length === 0}
      <EmptyState title="Nothing here yet" description="TODO: say what will appear." />
    {:else}
      {#each $marketplace as row (row.id)}
        <p class="text-sm text-gray-300">{row.id}</p>
      {/each}
    {/if}
  </div>
</Screen>
