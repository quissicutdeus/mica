<script lang="ts">
  // Every launcher glyph takes its size from the caller and defaults to h-8 w-8.
  let { class: className = 'h-8 w-8' }: { class?: string } = $props();
</script>

<!--
  `currentColor`, not a literal: the tile's `fg` (or its near-white default) is what this
  inherits, so one glyph reads correctly on a light tile and a dark one.
-->
<svg
  class={className}
  xmlns="http://www.w3.org/2000/svg"
  fill="none"
  viewBox="0 0 24 24"
  stroke="currentColor"
  aria-hidden="true"
>
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="2"
    d="M12 6v6l4 2M12 3a9 9 0 100 18 9 9 0 000-18z"
  />
</svg>
