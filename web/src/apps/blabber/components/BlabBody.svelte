<script lang="ts">
  import { tokenizeRichText } from '@gphone/sdk';

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
    onhandle,
    ontag
  }: {
    body: string;
    onhandle?: (handle: string) => void;
    ontag?: (tag: string) => void;
  } = $props();

  const tokens = $derived(tokenizeRichText(body));
</script>

<p class="text-on-surface text-sm leading-relaxed break-words whitespace-pre-wrap">
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
        class="font-semibold text-sky-300 hover:underline"
        onclick={() => ontag?.(token.value)}>#{token.value}</button
      >
    {:else}{token.value}{/if}
  {/each}
</p>
