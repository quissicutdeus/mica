import { charge } from './state/charge';
import { contacts } from '../services/contacts';
import { mailStore } from '../services/mail';
import { conversationsStore } from '../services/conversations';
import { appRegistryStore } from './state/registry';
import { isCatalogEntry, type CatalogEntry } from './state/catalog';
import { setSignal } from './state/signal';
import { time } from './state/time';
import { hydrateSettings } from '../sdk/host/useStorage';
import { bootstrapStores, resetBootstrapState } from './state/bootstrap';
import { toast } from './state/toast';
import { messageOf } from '../lib/sdk/errors';
import { APP_EVENT_NUI_ACTION, parseAppEventEnvelope } from '@shared/appEvents';
import {
  MUSIC_BROADCASTS_NUI_ACTION,
  MUSIC_BROADCAST_VOLUMES_NUI_ACTION
} from '@shared/musicBroadcast';
import { deliverAppEvent } from './state/appEvents';
import { parseDeepLink } from '@shared/deepLink';
import { receiveNearbyBroadcasts, receiveNearbyVolumes } from './state/nearbyMusic';
import {
  parseContactShare,
  parseMusicBroadcastVolumes,
  parseMusicBroadcasts,
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
  /**
   * `@shared/nui` used to export a parser for this action that handed back a bare
   * `{ url }`, and the shell would `import()` whatever module answered from it — the
   * exact thing MICA-16 step 4 forbids. That parser and its payload type were deleted
   * outright rather than widened: nothing else used them, and a dead export still
   * advertising the old shape was worse than removing it. A catalog entry is the only
   * shape the registry can turn into a manifest without running the fetched code to ask
   * it, so that is what an NUI install now has to look like — validated here with
   * `isCatalogEntry`, the same validator `fetchCatalog` applies to a catalog response, so
   * an NUI payload is held to the same bar.
   */
  const installApp = (data: unknown) => {
    if (!isCatalogEntry(data)) {
      console.warn('[gPhone] installApp: payload is not a CatalogEntry', data);
      toast.show({
        type: 'error',
        app: 'store',
        message: 'Failed to install remote app: invalid catalog entry'
      });
      return;
    }
    const payload: CatalogEntry = data;

    // `isTrustedRemoteUrl` (which `installFromCatalog` checks) exempts `data:` URLs on
    // the assumption that nothing produces one from untrusted input. An NUI message is
    // untrusted input, and `data:text/javascript,<code>` would run arbitrary JS in the
    // shell's own context with no host check and no hash verification — there is no
    // legitimate reason a FiveM resource would push inline source over NUI instead of an
    // https:// URL. Reject it here, at the boundary, rather than widening the allowlist
    // check itself (which other, genuinely trusted, internal callers rely on).
    if (payload.bundleUrl.startsWith('data:')) {
      toast.show({
        type: 'error',
        app: 'store',
        message: 'Failed to install remote app: data: URLs are not allowed over NUI'
      });
      return;
    }

    appRegistryStore
      .installFromCatalog(payload)
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

    // MICA-155: the card's own firstname/lastname/phone are the sender's free choice —
    // `contacts.share` lets someone forward any saved card, not only their own — so they
    // carry no provenance on their own. `sender` is attached server-side from the actual
    // connection that emitted the event and is what the player can trust; it must be shown
    // before Accept, not folded into or hidden behind the claimed name.
    const senderLabel = share.sender?.name ?? share.sender?.citizenid ?? 'Unknown sender';

    toast.showContactShare({
      name: `${share.firstname ?? ''} ${share.lastname ?? ''}`.trim() || share.phone || 'Contact',
      phone: share.phone ?? '',
      avatar: share.avatar,
      senderLabel,
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

    // Installed-ness is checked separately from the permission, and has to be:
    // `getManifest` resolves a bundled add-on that has never been installed (so a deep
    // link can render one), which would otherwise let a *shipped but uninstalled* app
    // whose manifest happens to declare `notifications` raise toasts on a phone that
    // does not have it.
    const manifest = appRegistryStore.getManifest(envelope.app);
    if (!appRegistryStore.isInstalled(envelope.app)) {
      if (import.meta.env.DEV) {
        console.warn(`[appEvent] '${envelope.app}' asked for a toast but is not installed.`);
      }
      return;
    }
    if (!manifest?.permissions?.includes('notifications')) {
      if (import.meta.env.DEV) {
        console.warn(
          `[appEvent] '${envelope.app}' asked for a toast without declaring 'notifications'.`
        );
      }
      return;
    }

    // The one unsolicited, app-attributed arrival in the phone, and so the path Do Not
    // Disturb and the per-app mutes exist for (MICA-63). `deliverAppEvent` above has
    // already run: the data lands regardless, and only the toast is subject to policy.
    toast.show({
      source: 'app',
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
      // `server/lib/shell.ts`'s `notifyPlayer` — the server speaking to a player directly
      // rather than on any app's behalf, which is how moderation and the admin commands
      // reach somebody. Exempt from Do Not Disturb and from every mute: a warning a player
      // can silence is one they would never know had been sent (MICA-63).
      toast.show({
        source: 'system',
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
    /**
     * Who nearby is playing what, from the server. MICA-111 phase 2.
     *
     * Straight into `state/nearbyMusic.ts` with no toast and no notification, and that is
     * the right amount of ceremony: somebody within earshot starting a song is not an
     * event addressed to this player, it is a fact about the world. The phone's answer to
     * it is audio, not an interruption — and the notification the person actually wants,
     * if they want one, is silence, which is what the mute in the shade is for.
     */
    [MUSIC_BROADCASTS_NUI_ACTION]: (data: unknown) => {
      const list = parseMusicBroadcasts(data);
      if (list) receiveNearbyBroadcasts(list);
    },
    /**
     * How loud each of them is, from the game client's distance tick.
     *
     * Separate from the roster above because it arrives from a different sender at a
     * different rate — see `parseMusicBroadcasts` in `@shared/nui`. This is the hottest
     * route in the table by some distance, so it does exactly one thing.
     */
    [MUSIC_BROADCAST_VOLUMES_NUI_ACTION]: (data: unknown) => {
      const volumes = parseMusicBroadcastVolumes(data);
      if (volumes) receiveNearbyVolumes(volumes);
    },
    installApp,
    uninstallApp,
    receiveMail,
    receiveMessage,
    receiveContactShare,
    shareContact: receiveContactShare
  };

  return (event: MessageEvent): boolean => {
    const { action, data } = (event.data ?? {}) as { action?: string; data?: unknown };
    const route = typeof action === 'string' ? routes[action] : undefined;
    if (!route) return false;
    route(data);
    return true;
  };
}
