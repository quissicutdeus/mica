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

<svg
  xmlns="http://www.w3.org/2000/svg"
  class={className}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M21 3 3 10.5l6.5 2 2 6.5L21 3ZM11.5 12.5 3 10.5M11.5 12.5l2 6.5" />
</svg>
