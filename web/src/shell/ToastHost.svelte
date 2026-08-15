<script lang="ts">
  import { toast, type ToastMessage, type ToastAction } from './state/toast';
  import { fly } from 'svelte/transition';
  import CloseIcon from '../sdk/ui/icons/CloseIcon.svelte';
  import SendIcon from '../sdk/ui/icons/SendIcon.svelte';
  import Avatar from '../sdk/ui/Avatar.svelte';
  import { appRegistryStore } from './state/registry';

  let toasts = $derived($toast);

  // Track local reply input state per toast ID
  let replyInputs = $state<Record<string, string>>({});

  /**
   * A toast's surface, border and text, by kind.
   *
   * Two vocabularies on purpose, and the split is the same one the battery indicator
   * makes. Anything that names a *thing in the phone* — a message, a contact, an error —
   * is a themed role and follows the player's seed. Anything that is a **signal**, where
   * the color itself carries the meaning, stays a raw palette class: green means
   * "succeeded" and amber means "careful" to everyone, and M3's `tertiary` is generated
   * from the seed, so routing them through it would render a success toast in whatever
   * hue somebody picked. There is no M3 role for either, and inventing one would be
   * inventing a role that lies about what it is for.
   *
   * `error` is the exception that proves it: M3's error palette is *not* seeded, so it is
   * red under every theme and a themed role and a signal color at the same time.
   */
  const getBgColor = (type: ToastMessage['type']) => {
    switch (type) {
      case 'success':
        return 'bg-emerald-950/95 border-emerald-500/40 text-emerald-100';
      case 'warning':
        return 'bg-amber-950/95 border-amber-500/40 text-amber-100';
      case 'error':
        return 'bg-error-container border-error text-on-error-container';
      case 'message':
        return 'bg-surface-container-high border-primary text-on-surface';
      case 'call':
        return 'bg-surface-container-high border-emerald-500/40 text-on-surface';
      case 'contact':
        return 'bg-surface-container-high border-secondary text-on-surface';
      case 'info':
      default:
        return 'bg-surface-container-high border-outline-variant text-on-surface';
    }
  };

  const getActionBtnClass = (variant?: ToastAction['variant']) => {
    switch (variant) {
      case 'success':
        return 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/30';
      case 'danger':
        return 'bg-error hover:bg-error-hover text-on-error shadow-elevation-2';
      case 'primary':
        return 'bg-primary-container hover:bg-primary-container-hover text-on-primary-container shadow-elevation-2';
      case 'secondary':
      default:
        return 'bg-surface-container-high hover:bg-surface-container-high-hover text-on-surface border border-outline-variant';
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
        app: 'messages',
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
      <!-- Announced as a button only when tapping the body actually does something.
           A toast whose actions are its own inner buttons stays presentational, so it
           does not put an extra stop in the tab order that leads nowhere. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- `role` and `tabindex` are both keyed on `t.onClick`, so the pairing is always
           button+0 or presentation+none, and a presentational toast never takes a tab
           stop. The compiler checks the two attributes independently and cannot see that
           they move together; splitting the element in two to prove it would duplicate
           forty lines of markup to satisfy a static analysis rather than a user. -->
      <div
        transition:fly={{ y: -20, duration: 250 }}
        class="shadow-elevation-5 pointer-events-auto flex cursor-pointer flex-col space-y-2.5 rounded-lg border p-3 backdrop-blur-2xl transition-all hover:scale-[1.01] active:scale-[0.99] {getBgColor(
          t.type
        )} duration-short ease-standard"
        onclick={async () => {
          if (t.onClick) {
            await t.onClick();
          }
          toast.dismiss(t.id);
        }}
        onmouseenter={() => toast.pauseDismiss(t.id)}
        onmouseleave={() => toast.resumeDismiss(t.id, 4000)}
        onkeydown={(e) => {
          if (!t.onClick || (e.key !== 'Enter' && e.key !== ' ')) return;
          // Only the toast body. A keypress from Accept, Decline or the reply box
          // belongs to that control, not to the toast behind it.
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          void (async () => {
            await t.onClick!();
            toast.dismiss(t.id);
          })();
        }}
        onfocusin={() => toast.pauseDismiss(t.id)}
        onfocusout={() => toast.resumeDismiss(t.id, 4000)}
        role={t.onClick ? 'button' : 'presentation'}
        tabindex={t.onClick ? 0 : undefined}
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
            {#if t.app}
              {@const manifest = appRegistryStore.getManifest(t.app)}
              {#if manifest}
                <!-- Which app is talking, before what it's saying. Initials rather than
                     the manifest's own icon component: that renders at a fixed 32px
                     (AGENTS.md §11 icons are sized `h-8 w-8`), too large to shrink into
                     a header this small without a scaling hack — `NotificationShade`
                     already settled on initials for the same reason. -->
                <div class="mb-1 flex items-center gap-1.5">
                  <Avatar
                    src={typeof manifest.icon === 'string' ? manifest.icon : ''}
                    initials={manifest.name.charAt(0)}
                    bgClass={manifest.color}
                    size="h-4 w-4"
                    textClass="text-[8px]"
                  />
                  <span
                    class="text-on-surface-variant truncate text-[10px] font-bold tracking-wide uppercase"
                  >
                    {manifest.name}
                  </span>
                </div>
              {/if}
            {/if}
            {#if t.title}
              <h4 class="text-on-surface mb-0.5 truncate text-xs font-bold tracking-tight">
                {t.title}
              </h4>
            {/if}
            <p class="text-on-surface truncate text-xs leading-snug font-medium">
              {t.message}
            </p>
          </div>

          <button
            type="button"
            class="text-on-surface-variant hover:bg-surface-container-high-hover hover:text-on-surface duration-short ease-standard shrink-0 cursor-pointer rounded-full p-1 transition-colors"
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
              class="border-outline-variant bg-surface-container-lowest text-on-surface placeholder-on-surface-variant focus:ring-primary flex-1 rounded-xl border px-3 py-1.5 text-xs focus:ring-1 focus:outline-none"
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
              class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover shadow-elevation-2 duration-short ease-standard shrink-0 cursor-pointer rounded-xl p-1.5 transition-colors disabled:opacity-50"
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
                class="shadow-elevation-2 cursor-pointer rounded-xl px-3.5 py-1.5 text-xs font-semibold transition-all {getActionBtnClass(
                  act.variant
                )} duration-short ease-standard"
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
