// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import { audio } from './audio';
import { isBatteryDead } from './charge';
import { isPhoneOpen } from './phoneOpen';
import { addNotificationItem, clearNotifications } from '../../services/notifications';
import { notificationAllows } from './notificationPolicy';
import type { ToastMessage } from '../../../../sdk/vocabulary/shell';

let toastCounter = 0;

/**
 * The single most recent toast that arrived while the phone was collapsed, for the brief
 * top-of-screen peek (MICA-141) — `ClosedPhoneNotification.svelte` is the only reader.
 *
 * Deliberately the same `ToastMessage` the open phone would have painted through
 * `ToastHost.svelte`, rather than a parallel shape: the peek shows exactly what the real
 * banner would have, so there is nothing new to keep in sync with it.
 */
export const closedPhoneToast = writable<ToastMessage | null>(null);

const CLOSED_PEEK_DURATION_MS = 3000;
let closedPeekTimer: ReturnType<typeof setTimeout> | null = null;

const peekWhileClosed = (message: ToastMessage) => {
  if (closedPeekTimer) clearTimeout(closedPeekTimer);
  closedPhoneToast.set(message);
  closedPeekTimer = setTimeout(() => {
    closedPhoneToast.set(null);
    closedPeekTimer = null;
  }, CLOSED_PEEK_DURATION_MS);
};

/** The phone opening mid-peek supersedes it — `ToastHost.svelte`'s real banner takes over. */
isPhoneOpen.subscribe((open) => {
  if (!open) return;
  if (closedPeekTimer) {
    clearTimeout(closedPeekTimer);
    closedPeekTimer = null;
  }
  closedPhoneToast.set(null);
});

function createToastStore() {
  const store = writable<ToastMessage[]>([]);
  const { subscribe, update } = store;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Only ever one toast visible (the `store` above) — everything else waits here, in
  // arrival order, so five messages in a row take turns instead of overriding each other.
  let queue: ToastMessage[] = [];

  const clearToastTimer = (id: string) => {
    const existing = timers.get(id);
    if (existing) {
      clearTimeout(existing);
      timers.delete(id);
    }
  };

  const showNext = (next: ToastMessage) => {
    update(() => [next]);
    if (next.duration !== undefined && next.duration > 0) {
      scheduleToastTimer(next.id, next.duration);
    }
  };

  /** Pull the next queued toast into view. No-op if something is already visible. */
  const advanceQueue = () => {
    if (get(store).length > 0) return;
    const next = queue.shift();
    if (next) showNext(next);
  };

  const scheduleToastTimer = (id: string, duration: number) => {
    clearToastTimer(id);
    if (duration > 0) {
      const timer = setTimeout(() => {
        let expiring: ToastMessage | undefined;
        update((toasts) => {
          expiring = toasts.find((t) => t.id === id);
          return toasts.filter((t) => t.id !== id);
        });
        timers.delete(id);
        void expiring?.onExpire?.();
        advanceQueue();
      }, duration);
      timers.set(id, timer);
    }
  };

  /** Same title or sender as an already-pending toast — a repeat, not a new one to queue. */
  const findSpamMatch = (
    toasts: ToastMessage[],
    options: Partial<ToastMessage>
  ): ToastMessage | undefined =>
    toasts.find(
      (t) =>
        (options.title && t.title === options.title) ||
        (options.sender && t.sender === options.sender)
    );

  const show = (
    options: Partial<ToastMessage> & {
      message: string;
      /**
       * The caller already decided about — and possibly played — this arrival's sound
       * (`showMail`, `showContactShare`, `showIncomingMessage`, `showCall`, each with its
       * own effect and its own policy check). Set so the closed-phone peek below does not
       * layer a second, generic chime on top of one already made.
       */
      soundHandled?: boolean;
    }
  ) => {
    const id = options.id || `toast_${Date.now()}_${++toastCounter}`;

    const notificationItem =
      options.persist !== false
        ? addNotificationItem({
            app: options.app || (options.type === 'message' ? 'messages' : 'system'),
            title: options.title || options.sender || 'System Notification',
            body: options.message,
            avatar: options.avatar,
            deepLink: options.deepLink
          })
        : undefined;

    // The shade row is written above, unconditionally. Only the *banner* is subject to policy,
    // so a muted app's notification is still there when the player goes looking — that is the
    // whole of "suppress the interruption, never the record" (MICA-63).
    //
    // The id is returned either way. A caller holding one (`Shell.svelte`'s `incomingToastId`)
    // can then dismiss or archive it without having to know whether it was ever painted;
    // `dismiss` and `archive` are already no-ops for an id that is not in the store.
    if (
      !notificationAllows('banner', {
        source: options.source,
        app: options.app,
        breakThrough: options.breakThrough
      })
    ) {
      return id;
    }

    const newToast: ToastMessage = {
      id,
      notificationId: notificationItem?.id,
      app: options.app,
      source: options.source,
      breakThrough: options.breakThrough,
      title: options.title,
      message: options.message,
      type: options.type || 'info',
      duration: options.duration !== undefined ? options.duration : 4500,
      avatar: options.avatar,
      sender: options.sender,
      actions: options.actions,
      hasReplyInput: options.hasReplyInput,
      replyPlaceholder: options.replyPlaceholder,
      onReply: options.onReply,
      onClick: options.onClick,
      onExpire: options.onExpire
    };

    // MICA-141: a notification landing while the phone is collapsed still gets a chime
    // and a brief top-of-screen peek — `ClosedPhoneNotification.svelte` is the one thing
    // still rendered once `Shell.svelte` has torn `PhoneFrame` (and `ToastHost` with it)
    // down. Feedback is excluded — it confirms something the player just did, which
    // implies the phone was open to do it on — and so is a call, which already has its own
    // ringtone and a Decline/Accept story a disappearing peek would only get in the way of.
    // `options.source` defaults to `'feedback'` the same way `notificationPolicy.ts` itself
    // does — an unset source is never a real arrival, so it has to resolve the same way here
    // as it does over there, not fall through as merely-not-yet-'feedback'.
    const arrivalSource = options.source ?? 'feedback';
    if (!get(isPhoneOpen) && arrivalSource !== 'feedback' && newToast.type !== 'call') {
      if (
        !options.soundHandled &&
        notificationAllows('sound', {
          source: options.source,
          app: options.app,
          breakThrough: options.breakThrough
        })
      ) {
        audio.play('notification');
      }
      peekWhileClosed(newToast);
    }

    const visible = get(store);

    // A repeat of the visible toast replaces it in place and restarts its timer.
    const visibleMatch = findSpamMatch(visible, options);
    if (visibleMatch) {
      clearToastTimer(visibleMatch.id);
      showNext(newToast);
      return id;
    }

    // A repeat of a queued toast replaces it in place, keeping its position in line.
    const queueMatch = findSpamMatch(queue, options);
    if (queueMatch) {
      queue[queue.indexOf(queueMatch)] = newToast;
      return id;
    }

    if (visible.length === 0) {
      showNext(newToast);
      return id;
    }

    if (newToast.type === 'call') {
      // A call interrupts whatever is showing, which resumes once the call is handled.
      clearToastTimer(visible[0].id);
      queue.unshift(visible[0]);
      showNext(newToast);
      return id;
    }

    queue.push(newToast);
    return id;
  };

  const dismiss = (id: string) => {
    clearToastTimer(id);
    const wasVisible = get(store).some((t) => t.id === id);
    update((toasts) => toasts.filter((t) => t.id !== id));
    queue = queue.filter((t) => t.id !== id);
    if (wasVisible) advanceQueue();
  };

  /** Dismiss the toast and, if it created one, clear its notification from the drawer too. */
  const archive = async (id: string) => {
    const notificationId = get(store).find((t) => t.id === id)?.notificationId;
    dismiss(id);
    if (notificationId !== undefined) {
      await clearNotifications([notificationId]);
    }
  };

  const pauseDismiss = (id: string) => {
    clearToastTimer(id);
  };

  const resumeDismiss = (id: string, delay = 4000) => {
    scheduleToastTimer(id, delay);
  };

  return {
    subscribe,
    show,
    dismiss,
    archive,
    pauseDismiss,
    resumeDismiss,
    clear: () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      queue = [];
      update(() => []);
    },

    // Helper for incoming messages with interactive inline reply box
    showIncomingMessage: (options: {
      sender: string;
      message: string;
      avatar?: string;
      onReply: (replyText: string) => void | Promise<void>;
      onClick?: () => void | Promise<void>;
    }) => {
      if (notificationAllows('sound', { source: 'app', app: 'messages' })) audio.play('pop');
      return show({
        source: 'app',
        type: 'message',
        app: 'messages',
        title: options.sender,
        sender: options.sender,
        message: options.message,
        avatar: options.avatar,
        hasReplyInput: true,
        replyPlaceholder: 'Reply...',
        onReply: options.onReply,
        onClick: options.onClick,
        duration: 8000,
        soundHandled: true
      });
    },

    // Helper for contact share requests with standardized Accept & Decline buttons
    showContactShare: (options: {
      name: string;
      phone: string;
      avatar?: string;
      /**
       * MICA-155: who actually sent this card, resolved server-side from the connection
       * that emitted it — never the card's own claimed name, which `contacts.share`
       * deliberately lets be about someone else entirely (forwarding a friend's number).
       * Required, not optional, so a caller cannot silently drop it the way the toast used
       * to show only the claimed identity with nothing to check it against. The player
       * needs this *before* Accept, not after.
       */
      senderLabel: string;
      onAccept: () => void | Promise<void>;
      onDecline?: () => void | Promise<void>;
      onClick?: () => void | Promise<void>;
    }) => {
      if (notificationAllows('sound', { source: 'app', app: 'contacts' })) {
        audio.play('notification');
      }
      return show({
        source: 'app',
        type: 'contact',
        app: 'contacts',
        title: `Contact shared by ${options.senderLabel}`,
        message: `${options.name}${options.phone ? ` (${options.phone})` : ''}`,
        sender: options.senderLabel,
        avatar: options.avatar,
        duration: 10000,
        soundHandled: true,
        onClick: options.onClick || options.onAccept,
        actions: [
          {
            label: 'Accept',
            variant: 'success',
            onClick: async () => {
              await options.onAccept();
            }
          },
          {
            label: 'Decline',
            variant: 'danger',
            onClick: async () => {
              await options.onDecline?.();
            }
          }
        ]
      });
    },

    // Helper for incoming calls with standardized Accept & Decline buttons
    showCall: (options: {
      name?: string;
      number: string;
      /** `callBreaksThrough(number)` — a favourite or a repeat, so it rings despite DND. */
      breakThrough?: boolean;
      onAccept: () => void | Promise<void>;
      onDecline?: () => void | Promise<void>;
      onExpire?: () => void | Promise<void>;
    }) => {
      // A dead phone renders no children (PhoneFrame skips them), so the toast is
      // invisible — playing the ringtone anyway meant a dead phone rang with nothing
      // on screen and no way to answer.
      //
      // Do Not Disturb silences the ringtone and nothing else: the banner below still
      // appears, because it carries the only Accept button there is. See the long note in
      // `notificationPolicy.ts` — a suppressed call banner is an unanswerable call, not a
      // quiet one.
      if (
        !get(isBatteryDead) &&
        notificationAllows('sound', {
          source: 'call',
          app: 'phone',
          breakThrough: options.breakThrough
        })
      ) {
        audio.play('ringtone');
      }
      return show({
        source: 'call',
        breakThrough: options.breakThrough,
        type: 'call',
        app: 'phone',
        onExpire: options.onExpire,
        title: 'Incoming Call',
        message: options.name ? `${options.name} (${options.number})` : options.number,
        duration: 12000,
        soundHandled: true,
        actions: [
          {
            label: 'Accept',
            variant: 'success',
            onClick: async () => {
              await options.onAccept();
            }
          },
          {
            label: 'Decline',
            variant: 'danger',
            onClick: async () => {
              await options.onDecline?.();
            }
          }
        ]
      });
    },

    // Helper for new emails
    showMail: (options: { sender: string; subject: string; onClick?: () => void }) => {
      if (notificationAllows('sound', { source: 'app', app: 'mail' })) audio.play('notification');
      return show({
        source: 'app',
        type: 'info',
        app: 'mail',
        title: `New Email: ${options.sender}`,
        message: options.subject,
        duration: 5000,
        soundHandled: true,
        onClick: options.onClick
      });
    }
  };
}

export const toast = createToastStore();
