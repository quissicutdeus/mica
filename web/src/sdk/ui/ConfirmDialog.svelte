<script lang="ts">
  import { fade } from '../../lib/motion';
  import Button from './Button.svelte';
  import { focusTrap } from '../../lib/focusTrap';

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
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    confirmVariant = 'danger',
    isLoading = false,
    onconfirm,
    oncancel
  }: Props = $props();

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
    class="bg-surface-container shadow-elevation-5 w-full rounded-xl p-6 outline-none"
  >
    <h3 class="text-on-surface mb-2 text-xl font-bold">{title}</h3>
    <p class="text-on-surface-variant mb-6">{message}</p>
    <div class="flex gap-3">
      <Button class="flex-1" variant="secondary" onclick={oncancel} disabled={isLoading}>
        {cancelText}
      </Button>
      <Button class="flex-1" variant={confirmVariant} onclick={onconfirm} disabled={isLoading}>
        {isLoading ? 'Processing...' : confirmText}
      </Button>
    </div>
  </div>
</div>
