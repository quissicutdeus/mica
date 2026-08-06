<script lang="ts">
  import type { Component } from 'svelte';
  import { audio } from '../../shell/state/audio';

  /**
   * A bottom navigation bar: a small set of top-level destinations, exactly one of which is
   * current.
   *
   * Deliberately not `SegmentedControl`, which is the top-mounted idiom for filtering one list —
   * "Blabs" against "Replies" is the same screen twice. This is the other thing entirely: it
   * changes *what you are looking at*, it carries an icon per destination, and it sits at the
   * bottom of the screen. Nothing in the repo had a bottom nav, so this is the first one; it is a
   * shared primitive rather than one app's component because the accounts service already
   * anticipates a second social app wanting the identical shape.
   *
   * It was written once before Following existed and deleted unbuilt, which is the rule this file
   * set for itself about `ActionSheet`: a primitive nobody imports is not a primitive. A two-tab
   * nav whose second tab apologises for itself is the same thing one layer down.
   *
   * Render it in `Screen`'s `overlay` snippet, which sits outside the scroll container — so the
   * bar stays put while content moves, and the scrolling content owes it bottom padding or its
   * last row hides underneath.
   *
   * Conventions follow `SegmentedControl` on purpose. `aria-pressed` over `role="tab"`, because a
   * tablist without `tabpanel` ids and roving arrow-key focus is a worse lie to a screen reader
   * than the row of toggle buttons this actually is. A click sound on change, and a `badge` for a
   * count belonging to the destination rather than to the screen in front of it.
   */
  export interface TabOption {
    id: string;
    label: string;
    /** Any `@gphone/sdk` icon — the contract is a component taking a `class`. */
    icon: Component<{ class?: string }>;
    badge?: number;
  }

  let {
    options = [],
    selected = $bindable(''),
    onchange,
    'aria-label': ariaLabel
  }: {
    options: TabOption[];
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

<nav
  aria-label={ariaLabel}
  class="border-hairline bg-surface-overlay pb-safe-bottom absolute bottom-0 left-0 z-20 flex w-full border-t backdrop-blur-md"
>
  {#each options as opt (opt.id)}
    {@const Icon = opt.icon}
    <button
      type="button"
      aria-pressed={selected === opt.id}
      class="flex flex-1 cursor-pointer flex-col items-center gap-0.5 py-2 transition-colors {selected ===
      opt.id
        ? 'text-sky-400'
        : 'text-gray-500 hover:text-gray-300'}"
      onclick={() => select(opt.id)}
    >
      <span class="relative">
        <Icon class="h-5 w-5" />
        {#if opt.badge}
          <span
            class="bg-danger absolute -top-1.5 -right-2.5 min-w-4 rounded-full px-1 text-[10px] leading-4 font-bold text-white"
          >
            {opt.badge > 99 ? '99+' : opt.badge}
          </span>
        {/if}
      </span>
      <span class="text-[10px] font-semibold">{opt.label}</span>
    </button>
  {/each}
</nav>
