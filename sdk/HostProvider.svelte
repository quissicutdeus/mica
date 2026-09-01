<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

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
