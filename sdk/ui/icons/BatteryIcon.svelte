<script lang="ts">
  interface Props {
    class?: string;
    charge: number;
  }
  let { class: className = 'size-icon-sm', charge }: Props = $props();

  let fillColor = $derived(charge <= 20 ? 'var(--color-error)' : 'var(--color-on-surface)');
  let fillWidth = $derived(Math.max(1.5, (Math.min(100, Math.max(0, charge)) / 100) * 15));
</script>

<svg xmlns="http://www.w3.org/2000/svg" class={className} viewBox="0 0 24 12" fill="none">
  <rect
    x="0.75"
    y="0.75"
    width="19.5"
    height="10.5"
    rx="2.25"
    stroke="var(--color-on-surface-variant)"
    stroke-width="1.5"
  />
  <rect x="21.5" y="4" width="1.75" height="4" rx="0.875" fill="var(--color-on-surface-variant)" />
  <rect
    x="3"
    y="3"
    width={fillWidth}
    height="6"
    rx="1"
    fill={fillColor}
    style="transition: width 0.2s ease, fill 0.2s ease;"
  />
</svg>
