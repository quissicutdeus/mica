<script lang="ts">
  interface Props {
    class?: string;
  }
  let { class: className = 'h-7 w-7 text-on-surface' }: Props = $props();
</script>

<svg xmlns="http://www.w3.org/2000/svg" class={className} viewBox="0 0 20 20" fill="currentColor">
  <path
    fill-rule="evenodd"
    d="M10 1.5a1 1 0 01.4.083l6 2.5A1 1 0 0117 5v5c0 4.03-2.7 7.4-6.68 8.94a1 1 0 01-.64 0C5.7 17.4 3 14.03 3 10V5a1 1 0 01.6-.917l6-2.5A1 1 0 0110 1.5zm1 5.5a1 1 0 10-2 0v3a1 1 0 102 0V7zm-1 6.5a1 1 0 100 2 1 1 0 000-2z"
    clip-rule="evenodd"
  />
</svg>
