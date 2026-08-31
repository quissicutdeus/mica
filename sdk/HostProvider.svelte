<script lang="ts">
  import { setContext, type Snippet } from 'svelte';
  import { HOST_CONTEXT_KEY, type Host } from './host/protocol';

  let {
    host,
    children
  }: {
    host: Host;
    children?: Snippet;
  } = $props();

  $effect.pre(() => {
    setContext(HOST_CONTEXT_KEY, host);
  });
</script>

{#if children}
  {@render children()}
{/if}
