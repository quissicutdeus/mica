<script lang="ts">
  interface Props {
    class?: string;
  }
  let { class: className = 'h-5 w-5' }: Props = $props();
</script>

<svg xmlns="http://www.w3.org/2000/svg" class={className} viewBox="0 0 20 20" fill="currentColor">
  <path
    fill-rule="evenodd"
    d="M3 3a1 1 0 011-1h12a1 1 0 01.78 1.625L13.28 8l3.5 4.375A1 1 0 0116 14H5v4a1 1 0 11-2 0V3z"
    clip-rule="evenodd"
  />
</svg>
