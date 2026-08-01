<script lang="ts">
  import { audio } from '../../shell/state/audio';

  export interface SegmentOption {
    id: string;
    label: string;
  }

  let {
    options = [],
    selected = $bindable(''),
    onchange
  }: {
    options: SegmentOption[];
    selected: string;
    onchange?: (id: string) => void;
  } = $props();

  const select = (id: string) => {
    if (selected === id) return;
    selected = id;
    audio.play('click');
    onchange?.(id);
  };
</script>

<div class="flex w-full rounded-xl border border-gray-700/50 bg-gray-800/70 p-1 backdrop-blur-md">
  {#each options as opt}
    <button
      type="button"
      class="flex-1 cursor-pointer rounded-lg py-1.5 text-center text-xs font-semibold transition-all {selected ===
      opt.id
        ? 'bg-gray-700 text-white shadow-md'
        : 'text-gray-400 hover:text-gray-200'}"
      onclick={() => select(opt.id)}
    >
      {opt.label}
    </button>
  {/each}
</div>
