<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { t as translate } from './messages';
  import { toast } from './state/toast';
  import type { ToastAction, ToastMessage } from '../../../sdk/vocabulary/shell';
  import { fly } from '@mica/sdk';
  import CloseIcon from '../../../sdk/ui/icons/CloseIcon.svelte';
  import SendIcon from '../../../sdk/ui/icons/SendIcon.svelte';
  import Avatar from '../../../sdk/ui/Avatar.svelte';
  import { appRegistryStore } from './state/registry';
  import SwipeableToast from './SwipeableToast.svelte';

  let toasts = $derived($toast);

  /**
   * How loudly the region below speaks. Assertive interrupts whatever the screen reader is
   * currently saying, which is right for a phone that is ringing now and will stop ringing
   * on its own, and rude for everything else — a sent reply, a failed save and a new
   * message all wait their turn.
   */
  let isCall = $derived(toasts[0]?.type === 'call');

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
        message: $translate('shell.replySent'),
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

<!-- The stack is a live region, and it is mounted for the life of the phone (MICA-66).

     A toast appears without focus moving, so nothing announces it: the screen reader is
     still wherever the player left it, and the message they were just sent is silent. A
     live region is the mechanism for exactly that, and it has to already exist when its
     contents change — a region created in the same breath as its text is frequently not
     announced at all, because the reader was never told to watch it. Empty and
     `pointer-events-none`, it costs one node and blocks nothing (MICA-42).

     **The region wraps the toast rather than holding a copy of its text.** The obvious
     alternative — an `sr-only` div the host writes the message into — puts every
     notification into the document twice, so a player browsing the card with a reader
     hears it once from the region and again from the card itself. Wrapping announces the
     card that is actually there, once.

     **No `aria-atomic`.** Left at its default, only the nodes that changed are read, which
     is what keeps this from being worse than nothing: the card re-renders on every
     keystroke in its reply box and on every pause of its dismissal timer, and an atomic
     region would read the whole notification aloud over the player typing into it. Text
     insertions are announced; a dismissal, being a removal, is not.

     `aria-live` moves with the toast's kind rather than being fixed. It is set in the same
     DOM update as the card it describes, which is the one compromise the wrapping approach
     forces — the alternative, a region per politeness, means rendering the card into one of
     two containers, and a call arriving over a message would then be an unmount and a
     remount rather than a content swap, which is the crossfade MICA-37 exists to
     prevent. -->
<div
  class="pointer-events-none absolute top-12 right-3 left-3 z-50 mx-auto flex max-w-3xl flex-col gap-2"
  role={isCall ? 'alert' : 'status'}
  aria-live={isCall ? 'assertive' : 'polite'}
>
  {#if toasts[0]}
    {@const t = toasts[0]}
    <!-- Rendered by `{#if}` on toasts[0], deliberately not a keyed `{#each}` — only one
         toast is ever visible now (MICA-37), and a keyed list treats one toast replacing
         another as remove-old/add-new, which plays the outgoing card's exit transition and
         the incoming card's entrance transition at the same time: the old one visibly
         "pushed down" by the new one for the duration of the crossfade. `{#if}` keeps the
         same DOM node across a replacement — content updates in place with no transition —
         and still plays the intro/outro transitions correctly on genuine appear/disappear
         (no toast → one, or one → none). -->
    <!-- Announced as a button only when tapping the body actually does something.
           A toast whose actions are its own inner buttons stays presentational, so it
           does not put an extra stop in the tab order that leads nowhere. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- `role` and `tabindex` are both keyed on `t.onClick`, so the pairing is always
           button+0 or presentation+none, and a presentational toast never takes a tab
           stop. The compiler checks the two attributes independently and cannot see that
           they move together; splitting the element in two to prove it would duplicate
           forty lines of markup to satisfy a static analysis rather than a user. -->
    <!-- Left/right swipe archives (dismisses the toast and clears its notification from
           the drawer); up swipe just hides the toast, leaving the notification active. -->
    <SwipeableToast onArchive={() => toast.archive(t.id)} onHide={() => toast.dismiss(t.id)}>
      <div
        transition:fly={{ y: -20, duration: 250 }}
        class="shadow-elevation-3 pointer-events-auto flex cursor-pointer flex-col space-y-2.5 rounded-box border p-3.5 backdrop-blur-md transition-all hover:scale-[1.01] active:scale-[0.99] {getBgColor(
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
                    size="size-icon-sm"
                    textClass="text-label-small"
                  />
                  <span class="text-primary text-body-small truncate tracking-wide uppercase">
                    {manifest.name}
                  </span>
                </div>
              {/if}
            {/if}
            {#if t.title}
              <h4 class="text-on-surface text-body-medium mb-0.5 truncate">
                {t.title}
              </h4>
            {/if}
            <p class="text-on-surface text-body-small line-clamp-2 leading-relaxed">
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
            aria-label={$translate('shell.dismissNotification')}
          >
            <CloseIcon class="size-icon-sm" />
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
              class="border-outline-variant bg-surface-container-lowest text-on-surface placeholder-on-surface-variant focus:ring-focus-ring text-body-small flex-1 rounded-box border px-3 py-1.5 focus:ring-1 focus:outline-none"
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
              class="bg-primary-container text-on-primary-container hover:bg-primary-container-hover shadow-elevation-2 duration-short ease-standard shrink-0 cursor-pointer rounded-box p-1.5 transition-colors disabled:bg-disabled-container disabled:text-disabled-content"
              disabled={!replyInputs[t.id]?.trim()}
              onclick={(e) => handleSendReply(t, e)}
              aria-label={$translate('shell.sendReply')}
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
            {#each t.actions as act (act.label)}
              <button
                type="button"
                class="shadow-elevation-2 text-body-small cursor-pointer rounded-box px-3.5 py-1.5 transition-all {getActionBtnClass(
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
    </SwipeableToast>
  {/if}
</div>
