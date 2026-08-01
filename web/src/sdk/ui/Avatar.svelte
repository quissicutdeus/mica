<script lang="ts">
  interface Props {
    initials?: string;
    src?: string;
    size?: string;
    textClass?: string;
    bgClass?: string;
    showSilhouette?: boolean;
  }

  let {
    initials = '',
    src = '',
    size = 'w-10 h-10',
    textClass = 'text-sm',
    bgClass = 'bg-gray-700',
    showSilhouette = true
  }: Props = $props();

  let imageError = $state(false);
</script>

<div
  class="{size} flex items-center justify-center rounded-full font-bold {bgClass} {textClass} shrink-0 overflow-hidden"
>
  {#if src && !imageError}
    <img
      {src}
      alt={initials || 'Avatar'}
      class="h-full w-full object-cover"
      onerror={() => (imageError = true)}
    />
  {:else if showSilhouette || !initials}
    <svg class="h-2/3 w-2/3 fill-current text-gray-400" viewBox="0 0 24 24">
      <path
        d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
      />
    </svg>
  {:else}
    {initials}
  {/if}
</div>
