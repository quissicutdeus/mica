<script lang="ts">
  import { audio } from '../../shell/state/audio';

  /**
   * An on/off switch, optionally as a full settings row.
   *
   * Like `SegmentedControl`, this existed and nothing imported it, so Settings inlined
   * the same forty-odd characters of track-and-knob markup three times — and the three
   * copies had already drifted: two move the knob by `translate-x-6` and this one by
   * `translate-x-5`, two are `bg-gray-600` when off and this one `bg-gray-700`. None of
   * that was decided; it was copied and edited.
   *
   * With `label` the whole row is the hit target, which is what the hand-written ones
   * did by wrapping everything in a `<button>`. Without one, only the switch is.
   */
  let {
    checked = $bindable(false),
    disabled = false,
    onchange,
    label,
    description,
    accent = 'blue',
    id
  }: {
    checked?: boolean;
    disabled?: boolean;
    onchange?: (val: boolean) => void;
    label?: string;
    /** Secondary line under the label, for what the setting actually does. */
    description?: string;
    /** Developer Tools is emerald throughout; everything else is blue. */
    accent?: 'blue' | 'emerald';
    id?: string;
  } = $props();

  const toggle = () => {
    if (disabled) return;
    checked = !checked;
    audio.play('click');
    onchange?.(checked);
  };

  const onColor = $derived(accent === 'emerald' ? 'bg-emerald-600' : 'bg-blue-600');
</script>

{#snippet track()}
  <span
    class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out {checked
      ? onColor
      : 'bg-gray-600'}"
  >
    <span
      class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out {checked
        ? 'translate-x-5'
        : 'translate-x-0'}"
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
    class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700 disabled:cursor-default disabled:opacity-40"
  >
    <span class="flex flex-col">
      <span class="font-medium">{label}</span>
      {#if description}
        <span class="text-sm text-gray-400">{description}</span>
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
    class="cursor-pointer focus:outline-none disabled:cursor-default disabled:opacity-40"
  >
    {@render track()}
  </button>
{/if}
