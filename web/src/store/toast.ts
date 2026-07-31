import { writable } from 'svelte/store';
import { soundService } from './sound';

export type ToastType = 'info' | 'success' | 'warning' | 'error' | 'message' | 'call' | 'contact';

export interface ToastAction {
  label: string;
  variant?: 'primary' | 'secondary' | 'success' | 'danger';
  onClick: (textInput?: string) => void | Promise<void>;
}

export interface ToastMessage {
  id: string;
  title?: string;
  message: string;
  type: ToastType;
  duration?: number;
  avatar?: string;
  sender?: string;
  actions?: ToastAction[];
  hasReplyInput?: boolean;
  replyPlaceholder?: string;
  onReply?: (replyText: string) => void | Promise<void>;
  onClick?: () => void;
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
        update((toasts) => toasts.filter((t) => t.id !== id));
        timers.delete(id);
      }, duration);
      timers.set(id, timer);
    }
  };

  const show = (options: Partial<ToastMessage> & { message: string }) => {
    const id = `toast_${Date.now()}_${++toastCounter}`;
    const newToast: ToastMessage = {
      id,
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
      onClick: options.onClick
    };

    update((toasts) => [newToast, ...toasts]);

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
      soundService.play('pop');
      return show({
        type: 'message',
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
      soundService.play('notification');
      return show({
        type: 'contact',
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
    }) => {
      soundService.play('ringtone');
      return show({
        type: 'call',
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
      soundService.play('notification');
      return show({
        type: 'info',
        title: `New Email: ${options.sender}`,
        message: options.subject,
        duration: 5000,
        onClick: options.onClick
      });
    }
  };
}

export const toast = createToastStore();
