<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { fade } from '../lib/motion';
  import Button from './Button.svelte';
  import { focusTrap } from '../lib/focusTrap';
  import { t } from '../i18n';
  import './messages';

  interface Props {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    confirmVariant?: 'primary' | 'secondary' | 'danger';
    isLoading?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  }

  let {
    title,
    message,
    // `= undefined` rather than the word: the real default is the `$derived` below, and
    // the destructure still says what it said before — this prop may be omitted.
    confirmText = undefined,
    cancelText = undefined,
    confirmVariant = 'danger',
    isLoading = false,
    onconfirm,
    oncancel
  }: Props = $props();

  // `$derived` fallbacks rather than prop defaults: a default is evaluated once, so it
  // could not follow the locale, and keeping them props keeps the published surface the
  // same for a caller that passes its own words.
  const confirmLabel = $derived(confirmText ?? $t('ui.confirm'));
  const cancelLabel = $derived(cancelText ?? $t('ui.cancel'));

  let dialogRef = $state<HTMLElement | null>(null);

  /**
   * Focus the dialog itself, not one of its buttons.
   *
   * A confirm dialog that appears without moving focus is announced to nobody — the
   * screen reader is still sitting on whatever the player just activated, and the two
   * choices now on screen are silent. Focusing the container reads the dialog's label and
   * puts Tab inside it; focusing a *button* instead would read that button and skip the
   * question, and picking which of Confirm and Cancel deserves it is a decision this
   * component cannot make for every caller (`confirmVariant` is `danger` by default,
   * which is exactly the one that should not be pre-focused).
   */
  $effect(() => {
    dialogRef?.focus({ preventScroll: true });
  });
</script>

<div
  class="bg-scrim absolute inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-sm"
  transition:fade
>
  <div
    bind:this={dialogRef}
    use:focusTrap
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    class="bg-surface-container shadow-elevation-5 w-full rounded-box p-6 outline-none"
  >
    <h3 class="text-on-surface mb-2 text-xl font-bold">{title}</h3>
    <p class="text-on-surface-variant mb-6">{message}</p>
    <div class="flex gap-3">
      <Button class="flex-1" variant="secondary" onclick={oncancel} disabled={isLoading}>
        {cancelLabel}
      </Button>
      <Button class="flex-1" variant={confirmVariant} onclick={onconfirm} disabled={isLoading}>
        {isLoading ? $t('ui.processing') : confirmLabel}
      </Button>
    </div>
  </div>
</div>
