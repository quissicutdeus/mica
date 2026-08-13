import { sendNuiMessage } from '../lib/nui';
import { PhoneState } from '../lib/PhoneState';
import { openPhone, closePhone } from '../lib/PhoneVisibility';

/**
 * Shell-scoped client events — the ones that belong to the phone itself rather than to
 * any app.
 *
 * `shell` is the segment for these because the event name convention is
 * `gphone:<side>:<app>:<action>` and there is no app here. It matches what the rest of
 * the codebase already calls this layer.
 */

/**
 * A server-originated toast.
 *
 * The server has emitted this since the ace-denial paths were added, and **nothing was
 * listening** — five call sites across the call and battery systems pushed
 * notifications into the void, so a player denied permission saw no feedback at all.
 */
onNet(
  'gphone:client:shell:notify',
  (payload: { type?: string; title?: string; message?: string }) => {
    const message = typeof payload?.message === 'string' ? payload.message : '';
    if (!message) return;

    sendNuiMessage('notify', {
      type: payload?.type ?? 'info',
      title: payload?.title,
      message
    });
  }
);

/**
 * A freshly loaded character's phone should stop showing the previous one's data.
 *
 * `server/lib/shell.ts`'s `pushRehydrate` is the one place both frameworks'
 * character-loaded event feeds into this. The push carries nothing — the phone re-reads
 * everything over the ordinary bootstrap round trip, which already scopes each read to the
 * caller's citizenid.
 */
onNet('gphone:client:shell:rehydrate', () => {
  sendNuiMessage('rehydrateShell', {});
});

/**
 * The `SetPhoneEnabled` export. A job confiscating the phone, or an item that jams it.
 *
 * Disabling while open force-closes it the same way `hideFrame` does — leaving it open
 * would mean the ban applies to the *next* press of `M` rather than to right now.
 */
onNet('gphone:client:shell:setEnabled', (enabled: unknown) => {
  const value = enabled === true;
  PhoneState.setEnabled(value);
  if (!value && PhoneState.isOpen()) {
    closePhone();
  }
});

/**
 * The `OpenApp` export. Force-opens the phone and lands on the named app, the same
 * `appId?key=value` shape a notification's deep link already carries.
 *
 * Silently refused while the phone is disabled — there is no reply channel for this
 * event to report through, matching `guardNetEvent`'s own reasoning on the server side.
 */
onNet(
  'gphone:client:shell:openApp',
  (payload: { appId?: string; props?: Record<string, unknown> }) => {
    if (!PhoneState.isEnabled()) return;
    const appId = payload?.appId;
    if (!appId) return;

    if (!PhoneState.isOpen()) {
      openPhone();
    }
    sendNuiMessage('openApp', { appId, props: payload?.props ?? {} });
  }
);
