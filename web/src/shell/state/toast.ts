import { get, writable } from 'svelte/store';
import { audio } from './audio';
import { isBatteryDead } from './charge';
import { addNotificationItem } from '../../services/notifications';

type ToastType = 'info' | 'success' | 'warning' | 'error' | 'message' | 'call' | 'contact';

export interface ToastAction {
  label: string;
  variant?: 'primary' | 'secondary' | 'success' | 'danger';
  onClick: (textInput?: string) => void | Promise<void>;
}

export interface ToastMessage {
  id: string;
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
  const { subscribe, update } = writable<ToastMessage[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearToastTimer = (id: string) => {
    const existing = timers.get(id);
    if (existing) {
      clearTimeout(existing);
      timers.delete(id);
    }
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
      }, duration);
      timers.set(id, timer);
    }
  };

  const MAX_VISIBLE_TOASTS = 2;

  const show = (options: Partial<ToastMessage> & { message: string }) => {
    const id = options.id || `toast_${Date.now()}_${++toastCounter}`;
    const newToast: ToastMessage = {
      id,
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

    update((toasts) => {
      // If there is an active toast from the same title or sender, replace it to prevent spam
      const matchIndex = toasts.findIndex(
        (t) =>
          (options.title && t.title === options.title) ||
          (options.sender && t.sender === options.sender)
      );

      let next = [...toasts];
      if (matchIndex !== -1) {
        clearToastTimer(next[matchIndex].id);
        next[matchIndex] = newToast;
      } else {
        next = [newToast, ...next];
      }

      // Cap visible toasts to MAX_VISIBLE_TOASTS by dismissing the oldest non-interactive toast
      while (next.length > MAX_VISIBLE_TOASTS) {
        let oldestIndex = -1;
        for (let i = next.length - 1; i >= 0; i--) {
          if (!next[i].actions && !next[i].hasReplyInput) {
            oldestIndex = i;
            break;
          }
        }
        if (oldestIndex !== -1) {
          clearToastTimer(next[oldestIndex].id);
          next.splice(oldestIndex, 1);
        } else {
          break;
        }
      }

      return next;
    });

    if (options.persist !== false) {
      addNotificationItem({
        app: options.app || (options.type === 'message' ? 'messages' : 'system'),
        title: options.title || options.sender || 'System Notification',
        body: options.message,
        avatar: options.avatar,
        deepLink: options.deepLink
      });
    }

    if (newToast.duration !== undefined && newToast.duration > 0) {
      scheduleToastTimer(id, newToast.duration);
    }

    return id;
  };

  const dismiss = (id: string) => {
    clearToastTimer(id);
    update((toasts) => toasts.filter((t) => t.id !== id));
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
    pauseDismiss,
    resumeDismiss,
    clear: () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
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
