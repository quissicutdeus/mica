import { get, writable } from 'svelte/store';
import { audio } from './audio';
import { isBatteryDead } from './charge';
import { addNotificationItem, clearNotifications } from '../../services/notifications';

type ToastType = 'info' | 'success' | 'warning' | 'error' | 'message' | 'call' | 'contact';

export interface ToastAction {
  label: string;
  variant?: 'primary' | 'secondary' | 'success' | 'danger';
  onClick: (textInput?: string) => void | Promise<void>;
}

/** A single toast, as shown by `usePhoneNotification().toast`. */
export interface ToastMessage {
  id: string;
  /** The drawer notification this toast created, if any — lets a swipe-to-archive act on the right row. */
  notificationId?: number;
  app?: string;
  title?: string;
  message: string;
  type: ToastType;
  duration?: number;
  avatar?: string;
  sender?: string;
  deepLink?: string;
  persist?: boolean;
  actions?: ToastAction[];
  hasReplyInput?: boolean;
  replyPlaceholder?: string;
  onReply?: (replyText: string) => void | Promise<void>;
  onClick?: () => void;
  /**
   * Run when the toast times out on its own, as opposed to being dismissed or actioned.
   *
   * Exists because an expiring toast can leave state behind: an unanswered call toast
   * vanished after 12s while `callStore.status` stayed `'incoming'`, so the phone sat
   * open and focused showing a call with no way to end it.
   */
  onExpire?: () => void | Promise<void>;
}

let toastCounter = 0;

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

  const show = (options: Partial<ToastMessage> & { message: string }) => {
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

    const newToast: ToastMessage = {
      id,
      notificationId: notificationItem?.id,
      app: options.app,
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
      onClick?: () => void;
    }) => {
      audio.play('pop');
      return show({
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
        duration: 8000
      });
    },

    // Helper for contact share requests with standardized Accept & Decline buttons
    showContactShare: (options: {
      name: string;
      phone: string;
      avatar?: string;
      onAccept: () => void | Promise<void>;
      onDecline?: () => void | Promise<void>;
      onClick?: () => void | Promise<void>;
    }) => {
      audio.play('notification');
      return show({
        type: 'contact',
        app: 'contacts',
        title: 'Contact Shared',
        message: `${options.name}${options.phone ? ` (${options.phone})` : ''}`,
        avatar: options.avatar,
        duration: 10000,
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
      onAccept: () => void | Promise<void>;
      onDecline?: () => void | Promise<void>;
      onExpire?: () => void | Promise<void>;
    }) => {
      // A dead phone renders no children (PhoneFrame skips them), so the toast is
      // invisible — playing the ringtone anyway meant a dead phone rang with nothing
      // on screen and no way to answer.
      if (!get(isBatteryDead)) {
        audio.play('ringtone');
      }
      return show({
        type: 'call',
        app: 'phone',
        onExpire: options.onExpire,
        title: 'Incoming Call',
        message: options.name ? `${options.name} (${options.number})` : options.number,
        duration: 12000,
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
      audio.play('notification');
      return show({
        type: 'info',
        app: 'mail',
        title: `New Email: ${options.sender}`,
        message: options.subject,
        duration: 5000,
        onClick: options.onClick
      });
    }
  };
}

export const toast = createToastStore();
