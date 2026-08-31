<script lang="ts">
  interface Props {
    value: string;
    placeholder?: string;
    focusRingClass?: string;
    class?: string;
    /**
     * Opt-in only. A search field that autofocuses is right when opening it was itself the
     * player's explicit action (a toggle-gated field, a Search tab that only appears on tap) —
     * wrong when it renders unconditionally on an app's main screen, where autofocus steals the
     * first Backspace press before the player has touched anything (the shell refuses `back`
     * while a text field has focus). Defaults to `false` for that reason.
     */
    focus?: boolean;
  }

  let {
    value = $bindable(),
    placeholder = 'Search...',
    focusRingClass = 'focus:ring-focus-ring',
    class: className = 'bg-surface-container text-on-surface',
    focus: autofocus = false
  }: Props = $props();

  const focus = (node: HTMLInputElement) => {
    if (autofocus) node.focus();
  };
</script>

<input
  class="placeholder-on-surface-variant text-body-medium w-full rounded-lg px-4 py-2 focus:ring-1 focus:outline-none {className} {focusRingClass}"
  {placeholder}
  bind:value
  use:focus
/>
