<script lang="ts">
  interface Props {
    value: string;
    placeholder?: string;
    focusRingClass?: string;
    class?: string;
  }

  let {
    value = $bindable(),
    placeholder = 'Search...',
    focusRingClass = 'focus:ring-primary',
    class: className = 'bg-surface-container text-on-surface'
  }: Props = $props();

  const focus = (node: HTMLInputElement) => {
    node.focus();
  };
</script>

<input
  class="placeholder-on-surface-variant w-full rounded-lg px-4 py-2 text-sm focus:ring-1 focus:outline-none {className} {focusRingClass}"
  {placeholder}
  bind:value
  use:focus
/>
