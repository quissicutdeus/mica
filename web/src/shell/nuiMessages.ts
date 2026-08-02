import { charge } from './state/charge';
import { contacts } from '../services/contacts';
import { mailStore } from '../services/mail';
import { conversationsStore } from '../services/conversations';
import { appRegistryStore } from './state/registry';
import { setSignal } from './state/signal';
import { time } from './state/time';
import { toast } from './state/toast';

/**
 * Routing for messages the client pushes into the NUI.
 *
 * This was 168 lines of `else if` inside `App.svelte`, which is both the largest
 * single thing that file did and the least tested — twelve message types, including
 * the contact-share validation, covered only incidentally by a few e2e specs. Pulling
 * it out is what makes it testable at all; nothing here needs a DOM or a component.
 *
 * Only the cases that are pure store work live here. `setVisible` and `callStatus`
 * stay with the shell because they act on shell state — frame visibility and the id of
 * the ring toast — and threading that back through a callback would be more coupling,
 * not less.
 */

/** The little the router needs from the shell, rather than the whole component. */
export interface NotificationBridge {
  /** Raise the phone and open an app. Used by notification click-throughs. */
  openFromNotification(appName: string, props?: Record<string, unknown>): void;
}

/**
 * Build the handler.
 *
 * Returns whether the message was consumed, so the shell can act on what is left
 * instead of duplicating the list of what is handled here.
 */
export function createNuiMessageRouter(bridge: NotificationBridge) {
  const installApp = (data: any) => {
    if (!data?.url) return;
    appRegistryStore
      .loadRemoteApp(data.url)
      .then(({ manifest }) => {
        toast.show({ type: 'success', message: `App '${manifest.name}' installed successfully` });
      })
      .catch((err) => {
        toast.show({ type: 'error', message: err.message || 'Failed to install remote app' });
      });
  };

  const uninstallApp = (data: any) => {
    if (!data?.appId) return;
    try {
      appRegistryStore.unregisterApp(data.appId);
      toast.show({ type: 'info', message: 'App uninstalled' });
    } catch (err: any) {
      toast.show({ type: 'error', message: err.message || 'Failed to uninstall app' });
    }
  };

  const receiveMail = (data: any) => {
    mailStore.addReceivedMail(data);
    toast.showMail({
      sender: data.sender || 'Mail',
      subject: data.subject || 'New Message',
      onClick: () => bridge.openFromNotification('mail', { mailId: data.id })
    });
  };

  const receiveMessage = (data: any) => {
    conversationsStore.addReceivedMessage(data);
    toast.showIncomingMessage({
      sender: data.senderName || data.phone || 'Message',
      message: data.message || '',
      avatar: data.avatar,
      onReply: async (replyText) => {
        if (data.conversation_id) {
          await conversationsStore.sendMessage(data.conversation_id, replyText);
        }
      },
      onClick: () =>
        bridge.openFromNotification('messages', {
          conversationId: data.conversation_id,
          phone: data.phone || data.senderPhone
        })
    });
  };

  const receiveContactShare = (data: any) => {
    /**
     * Accepting is the same whether the player taps Accept or the toast body, so both
     * run this. It validates rather than trusting the payload: a share arriving with no
     * name or number would otherwise be written as a blank contact.
     */
    const accept = async () => {
      const firstname = typeof data.firstname === 'string' ? data.firstname.trim() : '';
      const phone = typeof data.phone === 'string' ? data.phone.trim() : '';

      if (!firstname || !phone) {
        toast.show({
          type: 'error',
          message: 'Cannot add contact: missing required name or phone number'
        });
        return;
      }

      try {
        await contacts.add({
          firstname,
          lastname: typeof data.lastname === 'string' ? data.lastname.trim() : '',
          phone,
          email: typeof data.email === 'string' ? data.email.trim() : undefined,
          avatar: typeof data.avatar === 'string' ? data.avatar : undefined,
          favorite: typeof data.favorite === 'boolean' ? data.favorite : false
        });
        toast.show({ type: 'success', message: 'Contact added to address book' });
      } catch (e: any) {
        toast.show({ type: 'error', message: e.message || 'Failed to add contact' });
      }
    };

    toast.showContactShare({
      name: `${data.firstname || ''} ${data.lastname || ''}`.trim() || data.phone || 'Contact',
      phone: data.phone || '',
      avatar: data.avatar,
      onAccept: accept,
      onDecline: () => {
        toast.show({ type: 'info', message: 'Contact share declined' });
      },
      onClick: accept
    });
  };

  const routes: Record<string, (data: any) => void> = {
    setTime: (data) => time.set(data),
    setCharge: (data) => {
      if (typeof data === 'number') charge.set(data);
    },
    setSignal: (data) => {
      if (typeof data === 'number') setSignal(data);
    },
    // Server-originated toast, relayed by the client's shell system. Used by the
    // ace-denial paths and the call failure cases.
    notify: (data) => {
      if (typeof data?.message !== 'string' || !data.message) return;
      toast.show({ type: data.type ?? 'info', title: data.title, message: data.message });
    },
    installApp,
    uninstallApp,
    receiveMail,
    receiveMessage,
    receiveContactShare,
    // Two names for one thing; the client has used both.
    shareContact: receiveContactShare
  };

  return (event: MessageEvent): boolean => {
    const { action, data } = event.data ?? {};
    const route = typeof action === 'string' ? routes[action] : undefined;
    if (!route) return false;
    route(data);
    return true;
  };
}
