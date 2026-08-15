<script lang="ts">
  import { audio } from '../../shell/state/audio';

  /**
   * An on/off switch, optionally as a full settings row.
   *
   * Like `SegmentedControl`, this existed and nothing imported it, so Settings inlined
   * the same forty-odd characters of track-and-knob markup three times — and the three
   * copies had already drifted: two move the knob by `translate-x-6` and this one by
   * `translate-x-5`, two were `bg-gray-600` when off and this one `bg-gray-700`. None of
   * that was decided; it was copied and edited.
   *
   * With `label` the whole row is the hit target, which is what the hand-written ones
   * did by wrapping everything in a `<button>`. Without one, only the switch is.
   *
   * There used to be an `accent` prop taking `'blue' | 'emerald'`, resolved by a ternary
   * on the literal color. It was the same mistake in miniature that the M3 roles exist
   * to end: two hard-coded colors mean exactly two themes are expressible, and neither
   * follows the one the player picked. The switch is `primary` now, whatever primary
   * happens to be. Developer Tools was the only caller.
   */
  let {
    checked = $bindable(false),
    disabled = false,
    onchange,
    label,
    description,
    id
  }: {
    checked?: boolean;
    disabled?: boolean;
    onchange?: (val: boolean) => void;
    label?: string;
    /** Secondary line under the label, for what the setting actually does. */
    description?: string;
    id?: string;
  } = $props();

  const toggle = () => {
    if (disabled) return;
    checked = !checked;
    audio.play('click');
    onchange?.(checked);
  };
</script>

{#snippet track()}
  <span
    class="duration-short ease-standard relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors {checked
      ? 'bg-primary'
      : 'bg-surface-container-highest'}"
  >
    <!-- The knob is `on-primary` when on so it stays legible against the filled track,
         and `outline` when off, where the track is a neutral container. Reading it off
         the roles rather than pinning it to white is what makes a light scheme work
         later without touching this file. -->
    <span
      class="shadow-elevation-1 duration-short ease-standard pointer-events-none inline-block h-5 w-5 transform rounded-full ring-0 transition {checked
        ? 'bg-on-primary translate-x-5'
        : 'bg-outline translate-x-0'}"
    ></span>
  </span>
{/snippet}

{#if label}
  <button
    {id}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    {disabled}
    onclick={toggle}
    class="hover:bg-surface-hover active:bg-surface-pressed disabled:text-disabled-content duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors disabled:cursor-default"
  >
    <span class="flex flex-col">
      <span class="font-medium">{label}</span>
      {#if description}
        <span class="text-on-surface-variant text-body-medium">{description}</span>
      {/if}
    </span>
    {@render track()}
  </button>
{:else}
  <button
    {id}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label="Toggle"
    {disabled}
    onclick={toggle}
    class="disabled:text-disabled-content cursor-pointer focus:outline-none disabled:cursor-default"
  >
    {@render track()}
  </button>
{/if}
