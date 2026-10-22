<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  let { class: className = 'size-icon-xl' }: { class?: string } = $props();
</script>

<!-- A flame: a spark caught. Sized `size-icon-xl` (2rem, the launcher glyph's size), `currentColor` so it
     follows the tile. -->
<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
  <path
    d="M12 3c.5 3-2.5 4.5-2.5 7.5 0 1 .4 1.9 1 2.5-2-.3-3.5-2-3.5-4C5 11 4.5 13 4.5 14.5a7.5 7.5 0 0 0 15 0C19.5 9 14 7 12 3z"
    stroke-width="2"
    stroke-linejoin="round"
  />
  <path
    d="M12 21a3 3 0 0 1-3-3c0-2 3-3.5 3-5.5 0 2 3 3.5 3 5.5a3 3 0 0 1-3 3z"
    fill="currentColor"
    stroke="none"
  />
</svg>
