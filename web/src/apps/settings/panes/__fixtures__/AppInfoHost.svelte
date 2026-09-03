<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * The shape `settings/index.svelte` mounts `AppInfo` in, reduced to what matters for
   * MICA-207: the pane's `app` is *derived* from a registry store, and it is unmounted
   * the moment the registry no longer holds that app. A test rendering `AppInfo` on its
   * own with a fixed prop can never see the prop go `null` under a running handler.
   */
  import AppInfo from '../AppInfo.svelte';
  import { registerMessages, type AppManifest } from '@gos/sdk';
  import type { Readable } from 'svelte/store';
  import en from '../../locales/en.json';
  import de from '../../locales/de.json';

  // `index.svelte` registers Settings' catalog for the running phone; this fixture mounts
  // one pane without it, so it registers the same catalog itself (MICA-214).
  registerMessages('settings', { en, de });

  const { registry, appId }: { registry: Readable<AppManifest[]>; appId: string } = $props();

  let removed = $state(false);
  const selectedApp = $derived(removed ? null : ($registry.find((a) => a.id === appId) ?? null));
</script>

{#if selectedApp}
  <AppInfo app={selectedApp} onremoved={() => (removed = true)} />
{:else}
  <p>no app selected</p>
{/if}
