<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    label,
    title,
    collapsed = false,
    raised = false,
    onclick,
    icon
  } = $props<{
    label: string;
    title?: string;
    collapsed?: boolean;
    /**
     * Clear a bottom bar rather than sitting on it.
     *
     * The position was hardcoded `bottom-5`, correct for a screen whose content runs to the
     * bottom edge and wrong the moment a `TabBar` shares the `overlay` snippet — the two
     * overlap. Opt-in, so the Messages and Contacts call sites keep the position they were
     * written against.
     */
    raised?: boolean;
    onclick: () => void;
    icon: Snippet;
  }>();
</script>

<button
  type="button"
  class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover shadow-primary-glow text-label-large shadow-elevation-3 duration-medium ease-standard absolute right-5 z-30 flex cursor-pointer items-center justify-center rounded-full transition-all active:scale-95 {raised
    ? 'bottom-20'
    : 'bottom-5'} {collapsed ? 'h-11 w-11 p-0' : 'gap-2 px-4 py-2.5'}"
  {onclick}
  title={title || label}
  aria-label={label}
>
  {@render icon()}
  {#if !collapsed}
    <span class="duration-medium whitespace-nowrap transition-all">{label}</span>
  {/if}
</button>
