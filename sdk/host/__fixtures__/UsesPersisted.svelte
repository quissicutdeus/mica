<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { Writable } from 'svelte/store';
  import { usePersisted } from '../usePersisted';

  // MICA-368: a store built inside a component, the shape snek's high score has — so a
  // test can mount and unmount it and see whether the registry still holds it after a GC.
  // `onstore` hands the store out, for the lazy-singleton case that must outlive the mount.
  let {
    appId,
    settingKey,
    onstore
  }: { appId: string; settingKey: string; onstore?: (store: Writable<number>) => void } = $props();

  // svelte-ignore state_referenced_locally
  const value = usePersisted(appId, settingKey, 0);
  // svelte-ignore state_referenced_locally
  onstore?.(value);
</script>

<span>{$value}</span>
