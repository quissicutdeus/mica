<script lang="ts">
  import { audio } from '../../shell/state/audio';

  let {
    checked = $bindable(false),
    disabled = false,
    onchange,
    label,
    id
  }: {
    checked?: boolean;
    disabled?: boolean;
    onchange?: (val: boolean) => void;
    label?: string;
    id?: string;
  } = $props();

  const toggle = () => {
    if (disabled) return;
    checked = !checked;
    audio.play('click');
    onchange?.(checked);
  };
</script>

<div class="flex items-center justify-between">
  {#if label}
    <label for={id} class="cursor-pointer text-sm font-medium text-gray-200">
      {label}
    </label>
  {/if}
  <button
    {id}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label || 'Toggle'}
    {disabled}
    onclick={toggle}
    class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-40 {checked
      ? 'bg-blue-600'
      : 'bg-gray-700'}"
  >
    <span
      class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out {checked
        ? 'translate-x-5'
        : 'translate-x-0'}"
    ></span>
  </button>
</div>
