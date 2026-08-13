<script lang="ts">
  import { setContext, type Snippet } from 'svelte';
  import type { AppManifest } from './manifest';
  import { CAPABILITY_CONTEXT_KEY } from './capability';

  let {
    appId,
    manifest,
    children
  }: {
    appId: string;
    manifest?: AppManifest;
    children?: Snippet;
  } = $props();

  $effect.pre(() => {
    setContext(CAPABILITY_CONTEXT_KEY, {
      appId,
      permissions: manifest?.permissions ?? []
    });
  });
</script>

{#if children}
  {@render children()}
{/if}
