import { charge } from './state/charge';
import { contacts } from '../services/contacts';
import { mailStore } from '../services/mail';
import { conversationsStore } from '../services/conversations';
import { appRegistryStore } from './state/registry';
import { setSignal } from './state/signal';
import { time, type TimeState } from './state/time';
import { toast, type ToastMessage } from './state/toast';
import { messageOf } from '../lib/errors';

/**
 * A message that arrived from the client, as something with readable fields.
 *
 * These handlers were typed `any`, which meant a typo in a field name compiled and
 * produced `undefined` at runtime — on the one boundary where every value was chosen by
 * something outside the web. Mirrors `server/lib/payload.ts`, for the same reason.
 */
const fields = (data: unknown): Record<string, unknown> =>
  data && typeof data === 'object' ? (data as Record<string, unknown>) : {};

const str = (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw.length > 0 ? raw : undefined;

const num = (raw: unknown): number | undefined => (typeof raw === 'number' ? raw : undefined);

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
  const installApp = (data: unknown) => {
    const url = str(fields(data).url);
    if (!url) return;
    appRegistryStore
      .loadRemoteApp(url)
      .then(({ manifest }) => {
        toast.show({ type: 'success', message: `App '${manifest.name}' installed successfully` });
      })
      .catch((err) => {
        toast.show({ type: 'error', message: messageOf(err, 'Failed to install remote app') });
      });
  };

  const uninstallApp = (data: unknown) => {
    const appId = str(fields(data).appId);
    if (!appId) return;
    try {
      appRegistryStore.unregisterApp(appId);
      toast.show({ type: 'info', message: 'App uninstalled' });
    } catch (err) {
      toast.show({ type: 'error', message: messageOf(err, 'Failed to uninstall app') });
    }
  };

  const receiveMail = (data: unknown) => {
    const mail = fields(data);
    mailStore.addReceivedMail(mail as unknown as Parameters<typeof mailStore.addReceivedMail>[0]);
    toast.showMail({
      sender: str(mail.sender) ?? 'Mail',
      subject: str(mail.subject) ?? 'New Message',
      onClick: () => bridge.openFromNotification('mail', { mailId: num(mail.id) })
    });
  };

  const receiveMessage = (data: unknown) => {
    const msg = fields(data);
    const conversationId = num(msg.conversation_id);
    conversationsStore.addReceivedMessage({
      conversation_id: conversationId,
      message: str(msg.message),
      senderName: str(msg.senderName),
      phone: str(msg.phone),
      avatar: str(msg.avatar),
      created_at: str(msg.created_at)
    });
    toast.showIncomingMessage({
      sender: str(msg.senderName) ?? str(msg.phone) ?? 'Message',
      message: str(msg.message) ?? '',
      avatar: str(msg.avatar),
      onReply: async (replyText) => {
        if (conversationId) await conversationsStore.sendMessage(conversationId, replyText);
      },
      onClick: () =>
        bridge.openFromNotification('messages', {
          conversationId,
          phone: str(msg.phone) ?? str(msg.senderPhone)
        })
    });
  };

  const receiveContactShare = (data: unknown) => {
    const share = fields(data);
    /**
     * Accepting is the same whether the player taps Accept or the toast body, so both
     * run this. It validates rather than trusting the payload: a share arriving with no
     * name or number would otherwise be written as a blank contact.
     */
    const accept = async () => {
      const firstname = str(share.firstname)?.trim() ?? '';
      const phone = str(share.phone)?.trim() ?? '';

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
          lastname: str(share.lastname)?.trim() ?? '',
          phone,
          email: str(share.email)?.trim(),
          avatar: str(share.avatar),
          favorite: share.favorite === true
        });
        toast.show({ type: 'success', message: 'Contact added to address book' });
      } catch (e) {
        toast.show({ type: 'error', message: messageOf(e, 'Failed to add contact') });
      }
    };

    toast.showContactShare({
      name:
        `${str(share.firstname) ?? ''} ${str(share.lastname) ?? ''}`.trim() ??
        str(share.phone) ??
        'Contact',
      phone: str(share.phone) ?? '',
      avatar: str(share.avatar),
      onAccept: accept,
      onDecline: () => {
        toast.show({ type: 'info', message: 'Contact share declined' });
      },
      onClick: accept
    });
  };

  const routes: Record<string, (data: unknown) => void> = {
    setTime: (data) => time.set(data as TimeState),
    setCharge: (data) => {
      if (typeof data === 'number') charge.set(data);
    },
    setSignal: (data) => {
      if (typeof data === 'number') setSignal(data);
    },
    // Server-originated toast, relayed by the client's shell system. Used by the
    // ace-denial paths and the call failure cases.
    notify: (data) => {
      const notification = fields(data);
      const message = str(notification.message);
      if (!message) return;
      toast.show({
        type: (str(notification.type) as ToastMessage['type']) ?? 'info',
        title: str(notification.title),
        message
      });
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
