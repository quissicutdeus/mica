<script lang="ts">
  import type { Snippet } from 'svelte';
  import SendIcon from './icons/SendIcon.svelte';

  /**
   * The bottom-anchored input row every conversation surface ends in.
   *
   * Written because there were two of these and they had drifted apart in every detail a
   * player can see: Messages painted `bg-surface-container` with a backdrop blur and a
   * `focus-within` ring on the focus-ring token, Blabber's DMs painted nothing, sat on a
   * different surface role, and outlined focus in a hardcoded `sky-600`. The send buttons
   * differed by an elevation, and only one textarea suppressed its scrollbar. None of that
   * was a decision; it is what two independent copies of the same row turn into.
   *
   * What stays with the caller is what genuinely differs between them: `leading` for a row
   * of controls before the field (Messages' attach button), `above` for anything stacked on
   * top of it (a reply preview, an attachment tray, Blabber's emoji picker), and the send
   * gate, since Messages can send an attachment with no text at all.
   *
   * The bottom inset is the reason this is one component rather than a documented pattern.
   * `PhoneFrame` paints its home-indicator gesture bar across the bottom of the screen —
   * full width, `z-60`, and a real button — so a row flush to the bottom edge has its lower
   * third inside a target that returns to the home screen. Both composers had it, and only
   * once the column above them was bounded (MICA-89) did they sit low enough to show it.
   */
  let {
    value = $bindable(''),
    placeholder = 'Message',
    maxlength,
    busy = false,
    canSend,
    onsend,
    leading,
    above
  }: {
    value: string;
    placeholder?: string;
    /** Matched to the column the text lands in, so the limit is met while typing. */
    maxlength?: number;
    busy?: boolean;
    /** Overrides the default "there is text to send" gate — an attachment counts too. */
    canSend?: boolean;
    onsend: () => void;
    /** Controls before the field. */
    leading?: Snippet;
    /** Anything stacked above the row: a reply preview, an attachment tray, a picker. */
    above?: Snippet;
  } = $props();

  const sendable = $derived(!busy && (canSend ?? value.trim().length > 0));
</script>

<!-- Two boxes so the inset is *clearance*, not a wider gap inside the row. The outer one
     carries the surface and the border and reaches all the way down behind the gesture bar;
     the inner one is the row, padded normally. Collapsing them into a single
     `pb-home-indicator` put the send button's edge exactly on the bar's, which reads as
     touching it. -->
<div
  class="border-outline-variant bg-surface-container pb-home-indicator border-t backdrop-blur-md"
>
  <div class="p-3">
    {@render above?.()}

    <div class="flex w-full items-end gap-2.5">
      {@render leading?.()}

      <div
        class="bg-surface-container-high text-on-surface focus-within:border-focus-ring focus-within:ring-focus-ring flex flex-1 items-center rounded-lg border border-transparent px-3.5 py-1.5 focus-within:ring-1"
      >
        <!-- `h-[22px]` with a `max-h-32` ceiling: one line by default, growing to a few as
             the draft does, and never taller than that. `no-scrollbar` because the overflow
             past the ceiling has to scroll and §5 forbids showing the bar for it. -->
        <textarea
          bind:value
          {placeholder}
          {maxlength}
          rows="1"
          class="no-scrollbar text-on-surface placeholder-on-surface-variant text-body-medium h-[22px] max-h-32 min-h-[22px] w-full resize-none bg-transparent p-0 leading-normal focus:outline-none"
          onkeydown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (sendable) onsend();
            }
          }}></textarea>
      </div>

      <!-- Icon-only with an `aria-label`, deliberately: the one that carried a word read
           **Post** inside a private conversation, because it was the public composer reused. -->
      <button
        type="button"
        class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover shadow-elevation-2 duration-short ease-standard flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        onclick={onsend}
        disabled={!sendable}
        aria-label="Send"
      >
        <SendIcon class="text-on-surface size-icon-sm" />
      </button>
    </div>
  </div>
</div>
