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
  <path d="M6 5.25 15 12 6 18.75V5.25Zm10.5 0H18v13.5h-1.5V5.25Z" />
</svg>
