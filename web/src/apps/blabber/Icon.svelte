<script lang="ts">
  let { class: className = 'h-8 w-8' }: { class?: string } = $props();
</script>

<!-- A megaphone, angled up-right, with two arcs for the sound.
     Stroke-only at 1.5 like every other icon in the set (§6): a silhouette reads cleanly at
     32px without a filled interior, which is why this shape suits an outline set where an open
     mouth would have needed either teeth or a convention break. -->
<svg
  class={className}
  fill="none"
  viewBox="0 0 24 24"
  stroke="currentColor"
  stroke-width="1.5"
  aria-hidden="true"
>
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    d="M3.75 12.75v-1.5a1.5 1.5 0 0 1 1.05-1.43l9.45-2.9a.75.75 0 0 1 .97.71v8.74a.75.75 0 0 1-.97.71l-9.45-2.9a1.5 1.5 0 0 1-1.05-1.43Z"
  />
  <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 15v3.75a1.5 1.5 0 0 0 3 0V15.9" />
  <path stroke-linecap="round" d="M17.5 9.75a3.75 3.75 0 0 1 0 4.5M20 7.5a7 7 0 0 1 0 9" />
</svg>
