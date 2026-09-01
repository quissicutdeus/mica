<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  interface Props {
    class?: string;
  }
  let { class: className = 'size-icon-sm' }: Props = $props();
</script>

<!-- A beamed quaver — deliberately the same mark as the Music app's tile glyph
     (`apps/music/Icon.svelte`), because the two are read together: the status bar says
     "something is playing" and the launcher tile is where the person goes to look at it.
     It is a separate file rather than a shared one because the shell may not import out
     of `apps/` and an app icon is its own; if the mark ever changes, both change.

     Filled rather than stroked, which the app's copy is not. This one is drawn at 14px in
     the status bar, where a 2px stroke on a 24-unit viewBox is a 1.2px hairline and the
     note heads close up into a smudge. -->
<svg xmlns="http://www.w3.org/2000/svg" class={className} viewBox="0 0 24 24" fill="currentColor">
  <!-- Beam -->
  <path d="M9 5.6 20 3.2v3L9 8.6V5.6Z" />
  <!-- Stems -->
  <path d="M9 5.6h1.6v11.2H9V5.6Z" />
  <path d="M18.4 3.2H20v9.6h-1.6V3.2Z" />
  <!-- Note heads, sitting at the foot of each stem -->
  <ellipse cx="7.5" cy="19.4" rx="3.1" ry="2.6" />
  <ellipse cx="16.9" cy="15.4" rx="3.1" ry="2.6" />
</svg>
