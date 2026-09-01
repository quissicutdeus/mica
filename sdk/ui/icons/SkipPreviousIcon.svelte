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

<svg xmlns="http://www.w3.org/2000/svg" class={className} viewBox="0 0 24 24" fill="currentColor">
  <path d="M18 5.25 9 12l9 6.75V5.25ZM6 5.25h1.5v13.5H6V5.25Z" />
</svg>
