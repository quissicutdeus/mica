<script lang="ts">
  let { class: className = 'h-8 w-8' }: { class?: string } = $props();
</script>

<!-- Sized h-8 w-8 like every other launcher icon. Same pin glyph as `sdk/ui/icons/
     LocationIcon.svelte`, so the tile reads as the same idea as the "Set Waypoint" and
     "Share My Location" buttons inside the app. -->
<svg class={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
  <path
    fill-rule="evenodd"
    d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z"
    clip-rule="evenodd"
  />
</svg>
