<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { EmojiPicker, MessageBar } from '@gos/sdk';

  /**
   * The DM input.
   *
   * A separate component rather than `Composer` with a label prop, because the two are diverging
   * rather than converging. Reusing the post composer here meant the send button read **Post**,
   * the counter counted down from 280 against a `varchar(500)` column, and "Posting as @handle"
   * appeared inside a private conversation with one other person.
   *
   * Parameterising it would paper over that and then force the public composer to carry whatever
   * a private surface grows next — emoji, GIFs, attachments — none of which a Blab is getting.
   *
   * What it *does* share with `messages`' composer is the row itself, which is now `MessageBar`
   * in the SDK. Two hand-written copies had drifted apart on surface role, focus colour, send
   * button elevation and scrollbar suppression — all visible, none of it decided. This file is
   * what is actually particular to a DM: the emoji picker above the row, and the 500-character
   * limit its column imposes.
   */

  /** 500, matching `gos_blabber_dms.body`. The server enforces it from the same declaration. */
  const LIMIT = 500;

  let {
    busy = false,
    onsubmit
  }: {
    busy?: boolean;
    onsubmit: (body: string) => void;
  } = $props();

  let text = $state('');

  const send = () => {
    if (!text.trim() || busy) return;
    onsubmit(text.trim());
    text = '';
  };
</script>

<MessageBar bind:value={text} maxlength={LIMIT} {busy} onsend={send}>
  {#snippet above()}
    <!-- The picker types an emoji into the body rather than sending it standalone — reacting to a
         message the person already sent is `ReactionBar`'s job, on the thread side, not this
         composer's. -->
    <div class="mb-1.5">
      <EmojiPicker onselect={(emoji: string) => (text += emoji)} />
    </div>
  {/snippet}
</MessageBar>
