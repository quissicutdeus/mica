import { sendNuiMessage } from '../lib/nui';
import {
  APP_EVENT_NET_EVENT,
  APP_EVENT_NUI_ACTION,
  parseAppEventEnvelope
} from '@shared/appEvents';

/**
 * Forwarding a server push into the NUI.
 *
 * Deliberately not part of `ServiceProxy`. That class is a **correlator** — a pending-callback
 * map, deterministic cbIds, a 15-second timeout — and a push has no cbId, no reply and nothing
 * to correlate. Adding it there would put an unrelated path inside a class with one job, and
 * that timeout is precisely what must not fire for an unsolicited event.
 *
 * Not gated on whether the phone is open, either: the CEF page is alive whether or not the frame
 * is visible, and gating here would drop exactly the events the NUI-side buffer exists to keep.
 */
onNet(APP_EVENT_NET_EVENT, (raw: unknown) => {
  const envelope = parseAppEventEnvelope(raw);
  if (!envelope) {
    console.error('[AppEvents] Dropped a malformed envelope from the server.');
    return;
  }
  sendNuiMessage(APP_EVENT_NUI_ACTION, envelope);
});
