// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DeviceState } from '../lib/DeviceState';
import { openDevice } from '../lib/DeviceVisibility';

// Calls do not use ServiceProxy: these are fire-and-forget NUI callbacks with no cbId to
// correlate and no server reply to await, so the request/response machinery does not
// apply. They answer the NUI callback immediately and let the server push state changes
// back through the `gos:client:*` events below.

/**
 * `exports` is a genuine FiveM global at runtime, but the bare identifier resolves to
 * the current module's own (empty) exports object under Node-based test runners —
 * `Database.ts`'s `oxmysql` getter hit the same thing first and solved it the same way.
 * Preferring `globalThis.exports` is what makes the calls below testable at all; in the
 * real client the two are the same object.
 */
const pmaVoice = (): any =>
  (globalThis as any).exports?.['pma-voice'] ?? (exports as any)['pma-voice'];

// NUI Callbacks
RegisterNuiCallbackType('startCall');
on('__cfx_nui:startCall', (data: { number: string }, cb: Function) => {
  TriggerServerEvent('gos:server:phone:start', data.number);
  cb({ status: 'dialing' });
});

RegisterNuiCallbackType('answerCall');
on('__cfx_nui:answerCall', (_: any, cb: Function) => {
  TriggerServerEvent('gos:server:phone:answer');
  cb({ status: 'connected' });
});

RegisterNuiCallbackType('endCall');
on('__cfx_nui:endCall', (_: any, cb: Function) => {
  TriggerServerEvent('gos:server:phone:end');
  cb({ status: 'idle' });
});

// Declining an incoming call is the same client-side action as hanging up: the server
// tears the call down for both parties. Was called by the incoming-call toast and by
// Settings' DevTools but registered nowhere, so declining silently did nothing.
RegisterNuiCallbackType('rejectCall');
on('__cfx_nui:rejectCall', (_: any, cb: Function) => {
  TriggerServerEvent('gos:server:phone:end');
  cb({ status: 'idle' });
});

// Settings > Developer Tools' "Simulate Incoming Call", in game. Admin-gated
// server-side (`gos:server:phone:simulateIncoming`) independently of the DevTools
// unlock, which is a display gate only.
RegisterNuiCallbackType('simulateIncomingCall');
on('__cfx_nui:simulateIncomingCall', (data: { number?: string }, cb: Function) => {
  TriggerServerEvent('gos:server:phone:simulateIncoming', data?.number);
  cb({ success: true });
});

/**
 * Microphone mute.
 *
 * pma-voice owns the mic, so this asks it to when it is present and otherwise just
 * acknowledges — the UI state is still worth keeping honest either way.
 */
RegisterNuiCallbackType('toggleMute');
on('__cfx_nui:toggleMute', (data: { muted: boolean }, cb: Function) => {
  try {
    pmaVoice()?.setPlayerTalkingOverride?.(!data?.muted);
  } catch {
    // pma-voice absent or a different version; the UI stays consistent regardless.
  }
  cb({ muted: Boolean(data?.muted) });
});

RegisterNuiCallbackType('toggleSpeaker');
on('__cfx_nui:toggleSpeaker', (data: { enabled: boolean }, cb: Function) => {
  // pma-voice exposes no speakerphone/submix control, so this is UI state only — the
  // icon already toggles client-side. Revisit if pma-voice adds a routing export.
  cb({ success: true });
});

// Server Events
onNet('gos:client:phone:incoming', (data: { from: string; callId: number }) => {
  // The phone is now open whether or not the player asked for it, through the same
  // sequence the key uses: focus, the frame, the prop in hand. It used to set the flag
  // and push `setVisible` by hand, which left no prop and — before the flag was shared —
  // a `M` press that re-opened instead of closing. Calls are the phone's (`chrome.calls`),
  // so a tablet that was up goes down (MICA-262).
  if (!DeviceState.isOpen('phone')) openDevice('phone');

  // Send incoming status
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: {
        status: 'incoming',
        number: data.from,
        // The client has no address book. The shell resolves a display name from its
        // own contacts store when the number matches a saved contact.
        name: 'Unknown'
      }
    })
  );
});

onNet('gos:client:phone:accepted', (data: { callId: number }) => {
  // Connect to PMA Voice Channel. Guarded the same way `toggleMute` is: without pma-voice
  // present, or a version that renamed this export, an unguarded call threw inside this
  // handler and the UI update below never ran — the phone showed "dialing" forever on a
  // call the server had already connected.
  try {
    pmaVoice()?.addPlayerToCall?.(data.callId);
  } catch {
    // pma-voice absent or a different version; the UI still reflects the connected call.
  }

  // Update UI
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'connected' }
    })
  );
});

onNet('gos:client:phone:ended', () => {
  // Disconnect from PMA Voice. Same guard as `accepted` above — a throw here must not
  // stop the phone from returning to idle.
  try {
    pmaVoice()?.removePlayerFromCall?.();
  } catch {
    // pma-voice absent or a different version; the UI still returns to idle.
  }

  // Update UI
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'idle' }
    })
  );
});

// If calls fail. Only ever emitted from the server's `start` handler — before an
// `accepted` event has ever been sent for this call — so no pma-voice channel was joined
// and there is deliberately no `removePlayerFromCall()` here to undo.
onNet('gos:client:phone:failed', () => {
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'idle' }
    })
  );
});
