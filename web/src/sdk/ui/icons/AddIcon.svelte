<script lang="ts">
  interface Props {
    class?: string;
  }
  let { class: className = 'h-6 w-6' }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  class={className}
  fill="none"
  viewBox="0 0 24 24"
  stroke="currentColor"
>
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
</svg>
