<script lang="ts">
  let { class: className = 'h-8 w-8' }: { class?: string } = $props();
</script>

<!-- A bullhorn: narrow mouthpiece with a handle on the left, flaring to a wide bell on
     the right, with sound arcs past the bell. Sized h-8 w-8 like every other launcher
     icon, `currentColor` like the other stroke-based icons so it follows the tile's own
     foreground rather than carrying a fixed color. -->
<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="2"
    d="M4 10.5v3L18 19V5L4 10.5z"
  />
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="2"
    d="M4 13.5h-1a1.5 1.5 0 01-1.5-1.5v0A1.5 1.5 0 014 10.5"
  />
  <path
    stroke-linecap="round"
    stroke-width="1.5"
    d="M20 8.5a5.5 5.5 0 010 7M21 6a8.5 8.5 0 010 12"
  />
</svg>
