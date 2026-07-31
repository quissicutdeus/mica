<script lang="ts">
  import ErrorBoundary from './ErrorBoundary.svelte';

  let { appName = 'TestApp', shouldCrash = false }: { appName?: string; shouldCrash?: boolean } =
    $props();
</script>

<ErrorBoundary {appName}>
  {#if shouldCrash}
    <div>
      {(() => {
        throw new Error('Test crash');
      })()}
    </div>
  {:else}
    <div>Normal Child Content</div>
  {/if}
</ErrorBoundary>
