<script lang="ts">
  import { fade } from 'svelte/transition';
  import Button from './Button.svelte';

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
</script>

<div
  class="bg-scrim absolute inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-sm"
  transition:fade
>
  <div class="bg-surface-container shadow-elevation-5 w-full rounded-xl p-6">
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
