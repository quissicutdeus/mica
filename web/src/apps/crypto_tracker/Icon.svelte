<script lang="ts">
  let { class: className = 'h-8 w-8' }: { class?: string } = $props();
</script>

<!-- Sized h-8 w-8 like every other launcher icon. -->
<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
  <circle cx="12" cy="12" r="9" stroke-width="2" />
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="2"
    d="M12 7v10M14.5 9.5c0-1.1-1.1-2-2.5-2s-2.5.9-2.5 2 1.1 2 2.5 2 2.5.9 2.5 2-1.1 2-2.5 2-2.5-.9-2.5-2"
  />
</svg>
