<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * Test-only: `Shell.svelte`'s running-app loop for add-ons, reduced to the part that
   * decides whether a frame is reused or rebuilt — a `{#each}` keyed on the instance id,
   * and an `AddOnFrame` for each add-on the registry resolves. `devAddOn.test.ts` uses it to
   * see that Reload mounts a new frame with the new code, not only a new registry entry.
   */
  import { runningApps } from '../state/navigation';
  import { appRegistryStore } from '../state/registry';
  import { hostForApp } from '../../../../sdk/host/inProcess/createInProcessHost';
  import AddOnFrame from '../addon/AddOnFrame.svelte';
</script>

{#each $runningApps as instance (instance.id)}
  {@const manifest = appRegistryStore.getManifest(instance.id)}
  {#if manifest && !manifest.core}
    <AddOnFrame
      appId={instance.id}
      {manifest}
      host={hostForApp(instance.id, manifest)}
      props={instance.props}
      active={true}
      onKey={() => {}}
      onTyping={() => {}}
    />
  {/if}
{/each}
