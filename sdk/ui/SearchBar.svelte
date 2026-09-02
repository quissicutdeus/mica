<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { t } from '../i18n';
  import './messages';

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
    // See `placeholderText` below: the default moved to a `$derived` so it can follow the
    // locale, and `= undefined` keeps the prop optional exactly as before.
    placeholder = undefined,
    focusRingClass = 'focus:ring-focus-ring',
    class: className = 'bg-surface-container text-on-surface',
    focus: autofocus = false
  }: Props = $props();

  // A `$derived` fallback rather than a prop default, so the placeholder follows the
  // locale; a default is evaluated once. The prop stays optional either way.
  const placeholderText = $derived(placeholder ?? $t('ui.search'));

  const focus = (node: HTMLInputElement) => {
    if (autofocus) node.focus();
  };
</script>

<input
  class="placeholder-on-surface-variant text-body-medium w-full rounded-box px-4 py-2 focus:ring-1 focus:outline-none {className} {focusRingClass}"
  placeholder={placeholderText}
  bind:value
  use:focus
/>
