import { charge } from './state/charge';
import { contacts } from '../services/contacts';
import { mailStore } from '../services/mail';
import { conversationsStore } from '../services/conversations';
import { appRegistryStore } from './state/registry';
import { setSignal } from './state/signal';
import { time } from './state/time';
import { hydrateSettings } from '../sdk/host/useStorage';
import { bootstrapStores, resetBootstrapState } from './state/bootstrap';
import { toast } from './state/toast';
import { messageOf } from '../lib/errors';
import { APP_EVENT_NUI_ACTION, parseAppEventEnvelope } from '@shared/appEvents';
import { deliverAppEvent } from './state/appEvents';
import { parseDeepLink } from '@shared/deepLink';
import {
  parseContactShare,
  parseInstallApp,
  parseNotify,
  parseOpenApp,
  parseReceiveMail,
  parseReceiveMessage,
  parseSetCharge,
  parseSetSignal,
  parseSetTime,
  parseUninstallApp
} from '@shared/nui';

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
    const payload = parseInstallApp(data);
    if (!payload) return;

    // `isTrustedRemoteUrl` (which `loadRemoteApp` checks) exempts `data:` URLs on the
    // assumption that nothing produces one from untrusted input. An NUI message is
    // untrusted input, and `data:text/javascript,<code>` would run arbitrary JS in the
    // shell's own context with no host check and no hash verification — there is no
    // legitimate reason a FiveM resource would push inline source over NUI instead of an
    // https:// URL. Reject it here, at the boundary, rather than widening the allowlist
    // check itself (which other, genuinely trusted, internal callers rely on).
    if (payload.url.startsWith('data:')) {
      toast.show({
        type: 'error',
        app: 'store',
        message: 'Failed to install remote app: data: URLs are not allowed over NUI'
      });
      return;
    }

    appRegistryStore
      .loadRemoteApp(payload.url)
      .then(({ manifest }) => {
        toast.show({
          type: 'success',
          app: 'store',
          message: `App '${manifest.name}' installed successfully`
        });
      })
      .catch((err) => {
        toast.show({
          type: 'error',
          app: 'store',
          message: messageOf(err, 'Failed to install remote app')
        });
      });
  };

  const uninstallApp = (data: unknown) => {
    const payload = parseUninstallApp(data);
    if (!payload) return;
    try {
      appRegistryStore.unregisterApp(payload.appId);
      toast.show({ type: 'info', app: 'store', message: 'App uninstalled' });
    } catch (err) {
      toast.show({
        type: 'error',
        app: 'store',
        message: messageOf(err, 'Failed to uninstall app')
      });
    }
  };

  const receiveMail = (data: unknown) => {
    const mail = parseReceiveMail(data);
    if (!mail) return;
    mailStore.addReceivedMail(mail as unknown as Parameters<typeof mailStore.addReceivedMail>[0]);
    toast.showMail({
      sender: mail.sender,
      subject: mail.subject,
      onClick: () => bridge.openFromNotification('mail', { mailId: mail.id })
    });
  };

  const receiveMessage = (data: unknown) => {
    const msg = parseReceiveMessage(data);
    if (!msg) return;
    conversationsStore.addReceivedMessage({
      conversation_id: msg.conversationId,
      message: msg.message,
      senderName: msg.senderName,
      phone: msg.phone,
      avatar: msg.avatar,
      created_at: msg.created_at,
      reply_to_id: msg.replyToId
    });
    toast.showIncomingMessage({
      sender: msg.senderName ?? msg.phone ?? 'Message',
      message: msg.message,
      avatar: msg.avatar,
      onReply: async (replyText) => {
        if (msg.conversationId) await conversationsStore.sendMessage(msg.conversationId, replyText);
      },
      onClick: () =>
        bridge.openFromNotification('messages', {
          conversationId: msg.conversationId,
          phone: msg.phone
        })
    });
  };

  const receiveContactShare = (data: unknown) => {
    const share = parseContactShare(data);
    if (!share) return;

    const accept = async () => {
      const firstname = share.firstname?.trim() ?? '';
      const phone = share.phone?.trim() ?? '';

      if (!firstname || !phone) {
        toast.show({
          type: 'error',
          app: 'contacts',
          message: 'Cannot add contact: missing required name or phone number'
        });
        return;
      }

      try {
        await contacts.add({
          firstname,
          lastname: share.lastname?.trim() ?? '',
          phone,
          email: share.email?.trim(),
          avatar: share.avatar,
          favorite: share.favorite === true
        });
        toast.show({ type: 'success', app: 'contacts', message: 'Contact added to address book' });
      } catch (e) {
        toast.show({
          type: 'error',
          app: 'contacts',
          message: messageOf(e, 'Failed to add contact')
        });
      }
    };

    toast.showContactShare({
      name: `${share.firstname ?? ''} ${share.lastname ?? ''}`.trim() || share.phone || 'Contact',
      phone: share.phone ?? '',
      avatar: share.avatar,
      onAccept: accept,
      onDecline: () => {
        toast.show({ type: 'info', app: 'contacts', message: 'Contact share declined' });
      },
      onClick: accept
    });
  };

  const appEvent = (data: unknown) => {
    const envelope = parseAppEventEnvelope(data);
    if (!envelope) return;

    // Data first, unconditionally. The permission gates the *toast*, not the payload.
    deliverAppEvent(envelope);

    if (!envelope.notify) return;

    const manifest = appRegistryStore.getManifest(envelope.app);
    if (!manifest?.permissions?.includes('notifications')) {
      if (import.meta.env.DEV) {
        console.warn(
          `[appEvent] '${envelope.app}' asked for a toast without declaring 'notifications'.`
        );
      }
      return;
    }

    toast.show({
      type: envelope.notify.type ?? 'info',
      app: envelope.app,
      title: envelope.notify.title,
      message: envelope.notify.message,
      avatar: envelope.notify.avatar,
      onClick: () => {
        const link = envelope.deepLink ? parseDeepLink(envelope.deepLink) : null;
        if (link) bridge.openFromNotification(link.app, link.props);
        else bridge.openFromNotification(envelope.app, envelope.payload);
      }
    });
  };

  const routes: Record<string, (data: unknown) => void> = {
    [APP_EVENT_NUI_ACTION]: appEvent,
    setTime: (data) => {
      const parsed = parseSetTime(data);
      if (parsed) time.set(parsed);
    },
    setCharge: (data) => {
      const parsed = parseSetCharge(data);
      if (parsed !== null) charge.set(parsed);
    },
    rehydrateSettings: () => {
      void hydrateSettings();
    },
    rehydrateShell: () => {
      resetBootstrapState();
      void bootstrapStores(true);
    },
    setSignal: (data) => {
      const parsed = parseSetSignal(data);
      if (parsed !== null) setSignal(parsed);
    },
    notify: (data) => {
      const parsed = parseNotify(data);
      if (!parsed) return;
      toast.show({
        type: parsed.type,
        title: parsed.title,
        message: parsed.message
      });
    },
    openApp: (data) => {
      const parsed = parseOpenApp(data);
      if (!parsed) return;
      bridge.openFromNotification(parsed.appId, parsed.props);
    },
    installApp,
    uninstallApp,
    receiveMail,
    receiveMessage,
    receiveContactShare,
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
