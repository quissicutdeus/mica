<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  let { class: className = 'h-8 w-8' }: { class?: string } = $props();
</script>

<!-- A speech bubble with a crescent cut into it: talk, after dark. Sized h-8 w-8 like every
     launcher icon, `currentColor` so it follows the tile. -->
<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
  <path
    d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z"
    stroke-width="2"
    stroke-linejoin="round"
  />
  <path d="M13.5 6.5a3 3 0 1 0 2 5.2 2.5 2.5 0 0 1-2-5.2z" fill="currentColor" stroke="none" />
</svg>
