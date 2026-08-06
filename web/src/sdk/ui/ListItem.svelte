<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * A tappable row. Every list in the phone is built from these.
   *
   * It announced itself as a button and could be tabbed to, and then did nothing when
   * you pressed Enter — the accessibility warning that says so was suppressed rather
   * than answered. Focusable and named "button" while ignoring the keyboard is worse
   * than a plain `<div>`: it promises an interaction it does not have.
   *
   * Still a `<div>` rather than a `<button>`, because rows legitimately contain their
   * own buttons — a favourite star, a chevron — and a button inside a button is invalid
   * and behaves unpredictably. So it takes the keyboard handling on itself instead.
   */
  interface Props {
    onclick: (event: MouseEvent | KeyboardEvent) => void;
    children: Snippet;
    class?: string;
  }

  let { onclick, children, class: className = '' }: Props = $props();

  const onkeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // Only the row itself. A keypress that reached here from a control inside the row
    // is that control's to handle, and activating both would fire two actions at once.
    if (event.target !== event.currentTarget) return;

    // Space scrolls the page by default, which is the opposite of activating the row.
    event.preventDefault();
    onclick(event);
  };
</script>

<div
  class="group hover:bg-surface-hover active:bg-surface-pressed flex w-full cursor-pointer items-center p-4 transition-colors {className}"
  {onclick}
  {onkeydown}
  role="button"
  tabindex="0"
>
  {@render children()}
</div>
