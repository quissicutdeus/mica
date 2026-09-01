<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  interface Props {
    class?: string;
  }
  let { class: className = 'h-12 w-12' }: Props = $props();
</script>

<svg xmlns="http://www.w3.org/2000/svg" class={className} viewBox="0 0 24 24" fill="currentColor">
  <path
    fill-rule="evenodd"
    d="M4.5 7.5a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-9Z"
    clip-rule="evenodd"
  />
</svg>
