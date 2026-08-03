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
  <div class="w-full rounded-xl bg-gray-800 p-6 shadow-2xl">
    <h3 class="mb-2 text-xl font-bold text-white">{title}</h3>
    <p class="mb-6 text-gray-400">{message}</p>
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
