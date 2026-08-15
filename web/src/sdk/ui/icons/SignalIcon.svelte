<script lang="ts">
  interface Props {
    class?: string;
    level?: number;
  }
  let { class: className = 'size-icon-sm', level = 4 }: Props = $props();
</script>

<svg xmlns="http://www.w3.org/2000/svg" class={className} viewBox="0 0 20 20" fill="currentColor">
  <!-- Bar 1 -->
  <rect x="1" y="14" width="3.5" height="5" rx="1" opacity={level >= 1 ? '1' : '0.3'} />
  <!-- Bar 2 -->
  <rect x="6" y="10" width="3.5" height="9" rx="1" opacity={level >= 2 ? '1' : '0.3'} />
  <!-- Bar 3 -->
  <rect x="11" y="6" width="3.5" height="13" rx="1" opacity={level >= 3 ? '1' : '0.3'} />
  <!-- Bar 4 -->
  <rect x="16" y="2" width="3.5" height="17" rx="1" opacity={level >= 4 ? '1' : '0.3'} />
</svg>
