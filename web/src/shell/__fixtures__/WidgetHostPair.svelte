<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import WidgetHost from '../WidgetHost.svelte';
  import type { WidgetEntry } from '../state/widgets';

  /** Two hosts in one tree, the way the Launcher's grid holds them, so a crash can reach both. */
  let { first, second }: { first: WidgetEntry; second: WidgetEntry } = $props();
</script>

<div data-host-pair>
  <WidgetHost entry={first} size="2x1" />
  <WidgetHost entry={second} size="2x1" />
</div>
