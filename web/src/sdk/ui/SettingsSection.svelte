<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * A labeled group of rows on one card — Settings' "CELLULAR SERVICE" / "BLUETOOTH &
   * PROXIMITY" style sections, and anywhere else a screen groups rows under a heading.
   *
   * Nine call sites across Settings had copied the same "uppercase label above a
   * `bg-surface-container` card, description paragraph below it" markup, and had already
   * drifted on spacing between copies. The label and footer live *inside* the card now —
   * one shaded block per group, rather than a plain-background label floating above it —
   * so this owns the chrome and a caller supplies only its rows.
   *
   * Deliberately not opinionated about what is between the header and the footer: some
   * sections are one `ToggleSwitch`, some are a slider plus a button with their own
   * `border-t`, one is a `grid` of choice buttons. A caller that wants dividers between
   * its own rows still reaches for `divide-outline-variant divide-y` itself.
   */
  let {
    title,
    footer,
    headerAction,
    children
  }: {
    title: string;
    /** Helper text under the rows, inside the card. */
    footer?: string;
    /** e.g. Shortcuts' "Reset to defaults" link, at the header's trailing edge. */
    headerAction?: Snippet;
    children: Snippet;
  } = $props();
</script>

<div class="bg-surface-container overflow-hidden rounded-xl">
  <div class="flex items-center justify-between px-4 pt-3 pb-1">
    <h2 class="text-on-surface-variant text-body-small tracking-wider uppercase">{title}</h2>
    {#if headerAction}
      {@render headerAction()}
    {/if}
  </div>
  {@render children()}
  {#if footer}
    <p class="text-on-surface-variant text-body-small px-4 pt-1 pb-3">{footer}</p>
  {/if}
</div>
