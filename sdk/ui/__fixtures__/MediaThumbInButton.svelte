<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * The shape most thumbs are rendered in (MICA-249): inside a button that opens the
   * picture — Media's grid tile, a Snatchr feed card. Svelte 5 delegates `onclick`, so
   * whether a reveal tap reaches that parent is a question only a Svelte parent can
   * answer; a raw listener on the mount container is not the same path.
   *
   * MICA-405: optionally named the way Media's tile is (`label`), holding a second still the
   * way a message bubble holds two attachments (`second`), and holding a nested control of
   * its own the way a bubble holds a quoted reply (`onquote`) — which is invalid nesting in
   * its own right, and drawn here only because a real call site does it.
   */
  import MediaThumb from '../MediaThumb.svelte';
  import type { MediaPreview } from '@mica/shared/types';

  const {
    item,
    onopen,
    label,
    second,
    onquote
  }: {
    item: MediaPreview;
    onopen: () => void;
    label?: string;
    second?: MediaPreview;
    onquote?: () => void;
  } = $props();
</script>

<button type="button" data-testid="opener" aria-label={label} onclick={onopen}>
  {#if onquote}
    <span
      role="button"
      tabindex="0"
      data-testid="quote"
      onclick={(event) => {
        event.stopPropagation();
        onquote();
      }}
      onkeydown={() => {}}>quote</span
    >
  {/if}
  <MediaThumb {item} />
  {#if second}
    <MediaThumb item={second} />
  {/if}
</button>
