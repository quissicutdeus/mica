<script lang="ts">
  interface Props {
    class?: string;
  }
  let { class: className = 'h-4 w-4' }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  class={className}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="m7 7 10 10-5 5V2l5 5L7 17" />
</svg>
