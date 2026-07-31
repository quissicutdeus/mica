<script lang="ts">
  import { toast, type ToastMessage, type ToastAction } from '../store/toast';
  import { fly } from 'svelte/transition';
  import CloseIcon from './icons/CloseIcon.svelte';
  import SendIcon from './icons/SendIcon.svelte';
  import Avatar from './Avatar.svelte';

  let toasts = $derived($toast);

  // Track local reply input state per toast ID
  let replyInputs = $state<Record<string, string>>({});

  const getBgColor = (type: ToastMessage['type']) => {
    switch (type) {
      case 'success':
        return 'bg-emerald-950/95 border-emerald-500/40 text-emerald-100';
      case 'warning':
        return 'bg-amber-950/95 border-amber-500/40 text-amber-100';
      case 'error':
        return 'bg-rose-950/95 border-rose-500/40 text-rose-100';
      case 'message':
        return 'bg-gray-900/95 border-blue-500/40 text-gray-100';
      case 'call':
        return 'bg-gray-900/95 border-emerald-500/40 text-gray-100';
      case 'contact':
        return 'bg-gray-900/95 border-indigo-500/40 text-gray-100';
      case 'info':
      default:
        return 'bg-gray-900/95 border-gray-700/60 text-gray-100';
    }
  };

  const getActionBtnClass = (variant?: ToastAction['variant']) => {
    switch (variant) {
      case 'success':
        return 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/30';
      case 'danger':
        return 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-900/30';
      case 'primary':
        return 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-900/30';
      case 'secondary':
      default:
        return 'bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700';
    }
  };

  const handleSendReply = async (t: ToastMessage, e?: MouseEvent) => {
    e?.stopPropagation();
    const text = replyInputs[t.id] || '';
    if (!text.trim() || !t.onReply) return;
    try {
      await t.onReply(text.trim());
      replyInputs[t.id] = '';
      toast.dismiss(t.id);
      toast.show({
        type: 'success',
        message: 'Reply sent',
        duration: 2500
      });
    } catch (e) {
      console.error('Failed to send toast reply:', e);
    }
  };

  const handleActionClick = async (t: ToastMessage, action: ToastAction, e?: MouseEvent) => {
    e?.stopPropagation();
    try {
      await action.onClick(replyInputs[t.id]);
      toast.dismiss(t.id);
    } catch (e) {
      console.error('Toast action error:', e);
    }
  };
</script>

{#if toasts.length > 0}
  <div class="pointer-events-none absolute top-12 right-3 left-3 z-50 flex flex-col gap-2">
    {#each toasts as t (t.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        transition:fly={{ y: -20, duration: 250 }}
        class="pointer-events-auto flex cursor-pointer flex-col space-y-2.5 rounded-2xl border p-3 shadow-2xl backdrop-blur-2xl transition-all hover:scale-[1.01] active:scale-[0.99] {getBgColor(
          t.type
        )}"
        onclick={async () => {
          if (t.onClick) {
            await t.onClick();
          }
          toast.dismiss(t.id);
        }}
        onmouseenter={() => toast.pauseDismiss(t.id)}
        onmouseleave={() => toast.resumeDismiss(t.id, 4000)}
        onfocusin={() => toast.pauseDismiss(t.id)}
        onfocusout={() => toast.resumeDismiss(t.id, 4000)}
        role="presentation"
      >
        <div class="flex items-start gap-3">
          {#if t.avatar || t.sender || t.type === 'message' || t.type === 'contact'}
            <div class="shrink-0">
              <Avatar
                src={t.avatar}
                initials={t.sender ? t.sender[0] : t.title ? t.title[0] : 'N'}
                size="w-9 h-9"
                textClass="text-sm"
              />
            </div>
          {/if}

          <div class="min-w-0 flex-1">
            {#if t.title}
              <h4 class="mb-0.5 truncate text-xs font-bold tracking-tight text-white">
                {t.title}
              </h4>
            {/if}
            <p class="truncate text-xs leading-snug font-medium text-gray-300">
              {t.message}
            </p>
          </div>

          <button
            type="button"
            class="shrink-0 cursor-pointer rounded-full p-1 text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
            onclick={(e) => {
              e.stopPropagation();
              toast.dismiss(t.id);
            }}
            aria-label="Dismiss notification"
          >
            <CloseIcon class="h-4 w-4" />
          </button>
        </div>

        {#if t.hasReplyInput}
          <!-- Inline Reply Input Box -->
          <div
            class="flex items-center gap-2 pt-1"
            onclick={(e) => e.stopPropagation()}
            role="presentation"
          >
            <input
              type="text"
              class="flex-1 rounded-xl border border-gray-700/60 bg-gray-950/70 px-3 py-1.5 text-xs text-white placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              placeholder={t.replyPlaceholder || 'Type a reply...'}
              bind:value={replyInputs[t.id]}
              onfocus={() => toast.pauseDismiss(t.id)}
              onblur={() => toast.resumeDismiss(t.id, 4000)}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSendReply(t);
                }
              }}
            />
            <button
              type="button"
              class="shrink-0 cursor-pointer rounded-xl bg-blue-600 p-1.5 text-white shadow-md transition-colors hover:bg-blue-500 disabled:opacity-50"
              disabled={!replyInputs[t.id]?.trim()}
              onclick={(e) => handleSendReply(t, e)}
              aria-label="Send reply"
            >
              <SendIcon class="h-3.5 w-3.5" />
            </button>
          </div>
        {/if}

        {#if t.actions && t.actions.length > 0}
          <!-- Action Buttons -->
          <div
            class="flex items-center justify-end gap-2 pt-1"
            onclick={(e) => e.stopPropagation()}
            role="presentation"
          >
            {#each t.actions as act}
              <button
                type="button"
                class="cursor-pointer rounded-xl px-3.5 py-1.5 text-xs font-semibold shadow-md transition-all {getActionBtnClass(
                  act.variant
                )}"
                onclick={(e) => handleActionClick(t, act, e)}
              >
                {act.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
