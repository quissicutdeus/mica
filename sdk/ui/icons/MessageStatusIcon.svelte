<script lang="ts">
  let { status = 'delivered', class: className = 'w-3.5 h-3.5' } = $props<{
    status: 'delivered' | 'read';
    class?: string;
  }>();
</script>

{#if status === 'read'}
  <!-- Read: Full background color circle with lighter checkmark inside (inverse) -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    class="{className} shrink-0 text-blue-500"
  >
    <title>Read</title>
    <path
      fill-rule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
      clip-rule="evenodd"
    />
  </svg>
{:else}
  <!-- Delivered: Hollowed out checkmark with a circle around it -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    stroke-width="2"
    stroke="currentColor"
    class="{className} shrink-0 text-gray-400"
  >
    <title>Delivered</title>
    <circle cx="12" cy="12" r="9" />
    <path stroke-linecap="round" stroke-linejoin="round" d="m9 12.75 2.25 2.25 4.5-4.5" />
  </svg>
{/if}
