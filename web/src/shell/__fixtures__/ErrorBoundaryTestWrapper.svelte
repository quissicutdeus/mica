<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import ErrorBoundary from '../ErrorBoundary.svelte';

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
