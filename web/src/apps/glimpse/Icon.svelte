<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  let { class: className = 'h-8 w-8' }: { class?: string } = $props();
</script>

<!-- A camera body seen face on: a rounded square, the lens, and the viewfinder dot in the
     corner. Sized h-8 w-8 like every launcher icon, `currentColor` so it follows the tile. -->
<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
  <rect x="3" y="3" width="18" height="18" rx="5" stroke-width="2" />
  <circle cx="12" cy="12" r="4" stroke-width="2" />
  <circle cx="17.25" cy="6.75" r="1" fill="currentColor" stroke="none" />
</svg>
