<script lang="ts">
  interface Props {
    class?: string;
  }
  let { class: className = 'size-icon-md' }: Props = $props();
</script>

<svg xmlns="http://www.w3.org/2000/svg" class={className} viewBox="0 0 20 20" fill="currentColor">
  <path
    d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-2.83-2h5.66A3 3 0 0110 18z"
  />
</svg>
