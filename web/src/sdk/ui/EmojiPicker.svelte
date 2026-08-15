<script lang="ts">
  import { fly } from 'svelte/transition';
  import CloseIcon from './icons/CloseIcon.svelte';
  import { EMOJI_PALETTE, EMOJI_CATALOG } from './emojiData';

  /**
   * The hybrid picker: a fixed palette row, always visible, plus a "+" that opens the full
   * catalog. The palette is a UI affordance — the fastest path to the six or so reactions a
   * conversation actually uses — not a constraint on what can be sent; the catalog behind "+"
   * accepts anything in it, and the server accepts anything plausible-length regardless of
   * which path it came from.
   */
  interface Props {
    onselect: (emoji: string) => void;
    class?: string;
  }

  let { onselect, class: className = '' }: Props = $props();

  let expanded = $state(false);

  const pick = (emoji: string) => {
    onselect(emoji);
    expanded = false;
  };
</script>

<div class="relative inline-block {className}">
  <div class="flex items-center gap-1">
    {#each EMOJI_PALETTE as emoji (emoji)}
      <button
        type="button"
        class="hover:bg-surface-container-high duration-short ease-standard flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-lg transition-colors"
        onclick={() => pick(emoji)}
        aria-label="React with {emoji}"
      >
        {emoji}
      </button>
    {/each}
    <button
      type="button"
      class="text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface duration-short ease-standard flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-lg transition-colors"
      onclick={() => (expanded = !expanded)}
      aria-label={expanded ? 'Close emoji picker' : 'More emoji'}
      aria-expanded={expanded}
    >
      +
    </button>
  </div>

  {#if expanded}
    <div
      class="border-outline-variant bg-surface-container-high shadow-elevation-4 absolute bottom-full left-0 z-10 mb-2 max-h-64 w-72 overflow-y-auto rounded-xl border p-3"
      transition:fly={{ y: 8, duration: 150 }}
    >
      <div class="mb-2 flex items-center justify-between">
        <span class="text-on-surface-variant text-body-small">Emoji</span>
        <button
          type="button"
          class="text-on-surface-variant hover:text-on-surface cursor-pointer"
          onclick={() => (expanded = false)}
          aria-label="Close emoji picker"
        >
          <CloseIcon class="size-icon-sm" />
        </button>
      </div>
      {#each EMOJI_CATALOG as category (category.label)}
        <p
          class="text-on-surface-variant mt-2 mb-1 text-[10px] font-semibold tracking-wide uppercase"
        >
          {category.label}
        </p>
        <div class="grid grid-cols-8 gap-0.5">
          {#each category.emoji as emoji (emoji)}
            <button
              type="button"
              class="hover:bg-surface-container text-body-large flex h-7 w-7 cursor-pointer items-center justify-center rounded"
              onclick={() => pick(emoji)}
              aria-label="React with {emoji}"
            >
              {emoji}
            </button>
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</div>
