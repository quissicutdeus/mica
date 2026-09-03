<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { tokenizeRichText } from '@gos/sdk';

  /**
   * A post's text, with mentions and tags styled.
   *
   * Rendered as **tokens through `{text}`**, never as an HTML string through `{@html}`. That is
   * the entire security story for player-written content here: Svelte escapes every expression,
   * so `<script>` in a Blab arrives as five visible characters and there is nothing to
   * sanitize, because nothing is ever parsed as markup. The one `{@html}` in this codebase is
   * Notes' markdown, and it earns it with `marked` + DOMPurify; matching that would be taking
   * on the same risk to gain styling we can do without it.
   */
  let {
    body,
    class: className = 'text-on-surface',
    onhandle,
    ontag
  }: {
    body: string;
    /**
     * The `on-` role the text carries, because a body is not always on `surface`. A DM bubble
     * sent by the player paints `bg-primary-container`, and a hardcoded `text-on-surface` there
     * is near-white on a tinted container (MICA-102). The caller owns the pairing, since it
     * is the only thing that knows which surface the body landed on.
     */
    class?: string;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
  } = $props();

  const tokens = $derived(tokenizeRichText(body));
</script>

<p class="text-body-medium leading-relaxed break-words whitespace-pre-wrap {className}">
  {#each tokens as token, i (i)}
    {#if token.kind === 'mention'}
      <button
        type="button"
        class="text-primary font-semibold hover:underline"
        onclick={() => onhandle?.(token.value)}>@{token.value}</button
      >
    {:else if token.kind === 'tag'}
      <button
        type="button"
        class="text-primary font-semibold hover:underline"
        onclick={() => ontag?.(token.value)}>#{token.value}</button
      >
    {:else}{token.value}{/if}
  {/each}
</p>
