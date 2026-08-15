<script lang="ts">
  import { audio } from '../../shell/state/audio';

  /**
   * A row of mutually exclusive choices — the tab bar at the top of a list.
   *
   * This existed and nothing imported it, so every app that wanted tabs wrote its own:
   * Admin and Store both rendered two buttons with a ternary on the class string, and
   * Store's rendered `class:` directives inside a `class="…"` attribute, so the active
   * state came out as literal text and no tab ever looked selected. That is the failure
   * mode a shared primitive removes — not the twelve lines.
   *
   * `badge` is for a count that belongs to the tab rather than the screen behind it, as
   * Admin's pending queue does.
   */
  export interface SegmentOption {
    id: string;
    label: string;
    badge?: number;
  }

  let {
    options = [],
    selected = $bindable(''),
    onchange,
    'aria-label': ariaLabel
  }: {
    options: SegmentOption[];
    selected: string;
    onchange?: (id: string) => void;
    'aria-label'?: string;
  } = $props();

  const select = (id: string) => {
    if (selected === id) return;
    selected = id;
    audio.play('click');
    onchange?.(id);
  };
</script>

<!-- `aria-pressed` rather than `role="tab"`: a tablist without `tabpanel` ids and arrow-key
     roving focus is a worse lie to a screen reader than a row of toggle buttons, which is
     what this is. It is also what the apps already announced. -->
<div
  role="group"
  aria-label={ariaLabel}
  class="border-outline-variant bg-surface-container-low flex w-full rounded-xl border p-1 backdrop-blur-md"
>
  {#each options as opt (opt.id)}
    <button
      type="button"
      aria-pressed={selected === opt.id}
      class="text-label-large flex-1 cursor-pointer rounded-lg py-1.5 text-center transition-all {selected ===
      opt.id
        ? 'bg-surface-container-high-selected text-on-surface shadow-elevation-1'
        : 'text-on-surface-variant hover:text-on-surface'} duration-short ease-standard"
      onclick={() => select(opt.id)}
    >
      {opt.label}
      {#if opt.badge}
        <span class="bg-error text-on-error text-label-small ml-1 rounded-full px-1.5"
          >{opt.badge}</span
        >
      {/if}
    </button>
  {/each}
</div>
