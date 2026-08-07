<script lang="ts">
  import FlagIcon from './icons/FlagIcon.svelte';

  /**
   * The one way to offer "report this".
   *
   * It existed three times before — a flag in Photos, a differently-sized flag in a message
   * bubble, and nothing at all on a Blab, a DM or a profile, which could not be reported
   * regardless. Three copies of one affordance is three chances for them to drift apart,
   * and they had: different icon sizes and different hover colours for the same action.
   *
   * A component rather than a rule in a document, because "use the same report icon" is a
   * thing a reviewer has to notice and a component is a thing the compiler hands you.
   *
   * **Never offer this on the player's own content.** Reporting yourself is not moderation,
   * the server refuses it, and an affordance that always fails is worse than no affordance.
   * That check belongs to the caller, which is the only place that knows whose row it is.
   */
  interface Props {
    /** What is being reported, for the label — "photo", "message", "post", "account". */
    subject: string;
    onclick: () => void;
    /** `inline` sits in a row of actions; `header` sits among a screen's header buttons. */
    size?: 'inline' | 'header';
    class?: string;
  }

  let { subject, onclick, size = 'inline', class: className = '' }: Props = $props();

  /**
   * M3 wants a 24dp icon in a 48dp target, and 20dp where it sits inline among dense
   * secondary actions. Both keep the 48dp touch target — the padding grows as the glyph
   * shrinks, rather than the target shrinking with it.
   */
  let glyph = $derived(size === 'header' ? 'h-6 w-6' : 'h-5 w-5');
  let pad = $derived(size === 'header' ? 'p-3' : 'p-2');
</script>

<button
  type="button"
  {onclick}
  aria-label="Report {subject}"
  title="Report {subject}"
  class="text-on-surface-variant hover:text-error hover:bg-error-container focus-visible:ring-primary flex cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none {pad} {className}"
>
  <FlagIcon class={glyph} />
</button>
