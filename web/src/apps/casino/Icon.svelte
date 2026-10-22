<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  let { class: className = 'size-icon-xl' }: { class?: string } = $props();
</script>

<!-- A casino chip: a ring with four edge marks. 2rem (`size-icon-xl`), the launcher size;
     `currentColor` so it follows the tile. -->
<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
  <circle cx="12" cy="12" r="9" stroke-width="2" />
  <circle cx="12" cy="12" r="4" stroke-width="2" />
  <path stroke-linecap="round" stroke-width="2" d="M12 3v3M12 18v3M3 12h3M18 12h3" />
</svg>
