<script lang="ts">
  let { class: className = 'h-8 w-8' }: { class?: string } = $props();
</script>

<!-- A shopping cart — a clean break from the tag/string design, and a silhouette nothing
     else in the launcher uses (Store's own icon is a bag). Sized h-8 w-8 like every other
     launcher icon, `currentColor` like the other stroke-based icons so it follows the
     tile's own foreground rather than carrying a fixed color. -->
<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="2"
    d="M2 3h2l.6 2.4M5 6h15l-2.3 8.5a1.5 1.5 0 01-1.45 1.1H8.7a1.5 1.5 0 01-1.45-1.1L5 6z"
  />
  <circle cx="9" cy="20" r="1.5" stroke-width="2" />
  <circle cx="17" cy="20" r="1.5" stroke-width="2" />
</svg>
