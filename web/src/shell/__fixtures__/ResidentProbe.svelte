<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * Test-only: a resident app whose only job is to register what a background app
   * registers from inside its component — a search provider and a Control Center tile —
   * so `Shell.test.ts` can see when a resident app is mounted and when it is not (MICA-356).
   */
  import { useControlCenter, useSearchProvider, type AppProps } from '@mica/sdk';

  let { onback }: AppProps = $props();

  const ID = 'residentprobe';

  useSearchProvider(ID, (needle) =>
    'grocery list'.includes(needle) ? [{ id: 1, title: 'Grocery list' }] : []
  );
  useControlCenter(ID).registerToggle({
    id: 'probe',
    label: 'Probe',
    icon: 'MicrophoneIcon',
    active: false,
    onToggle: () => {}
  });
</script>

<h1>Resident Probe</h1>
<button onclick={onback}>Back</button>
