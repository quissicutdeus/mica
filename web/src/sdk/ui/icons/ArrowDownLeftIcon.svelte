<script lang="ts">
  interface Props {
    class?: string;
  }
  let { class: className = 'size-icon-sm' }: Props = $props();
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
  <path d="M17 7 7 17M16 17H7V8" />
</svg>
