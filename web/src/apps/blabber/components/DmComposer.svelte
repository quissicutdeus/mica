<script lang="ts">
  import { SendIcon } from '@gphone/sdk';

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
   * Shaped after `messages/components/MessageComposer.svelte` instead: an icon-only send button
   * with an `aria-label`, so there is no verb to get wrong, and Enter sends.
   */

  /** 500, matching `gphone_blabber_dms.body`. The server enforces it from the same declaration. */
  const LIMIT = 500;

  let {
    busy = false,
    onsubmit
  }: {
    busy?: boolean;
    onsubmit: (body: string) => void;
  } = $props();

  let text = $state('');

  const canSend = $derived(text.trim().length > 0 && !busy);

  const send = () => {
    if (!canSend) return;
    onsubmit(text.trim());
    text = '';
  };
</script>

<div class="border-outline-variant border-t p-3">
  <div class="flex w-full items-end gap-2.5">
    <!-- A solid `sky-600` focus border rather than `sky-500/50`: an opacity modifier compiles to
         `color-mix()`, which CEF 103 does not have (§6), and one hairline does not earn a theme
         token. It matches the send button, which is the color this app already uses. -->
    <div
      class="bg-surface-container flex flex-1 items-center rounded-2xl border border-transparent px-3.5 py-1.5 focus-within:border-sky-600"
    >
      <!-- maxlength as well: the server refuses an over-long body, and meeting the limit while
           typing beats being told after tapping send. -->
      <textarea
        bind:value={text}
        placeholder="Message"
        maxlength={LIMIT}
        rows="1"
        class="text-on-surface placeholder-on-surface-variant h-[22px] max-h-32 min-h-[22px] w-full resize-none bg-transparent p-0 text-sm leading-normal focus:outline-none"
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}></textarea>
    </div>

    <button
      type="button"
      class="bg-primary text-on-primary hover:bg-primary flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      onclick={send}
      disabled={!canSend}
      aria-label="Send"
    >
      <SendIcon class="text-on-surface h-4 w-4" />
    </button>
  </div>
</div>
