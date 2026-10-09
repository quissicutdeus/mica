// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DeviceState } from '../lib/DeviceState';
import { openDevice } from '../lib/DeviceVisibility';

// Calls do not use ServiceProxy: these are fire-and-forget NUI callbacks with no cbId to
// correlate and no server reply to await, so the request/response machinery does not
// apply. They answer the NUI callback immediately and let the server push state changes
// back through the `mica:client:*` events below.

/**
 * `exports` is a genuine FiveM global at runtime, but the bare identifier resolves to
 * the current module's own (empty) exports object under Node-based test runners —
 * `Database.ts`'s `oxmysql` getter hit the same thing first and solved it the same way.
 * Preferring `globalThis.exports` is what makes the calls below testable at all; in the
 * real client the two are the same object.
 */
const pmaVoice = (): any =>
  (globalThis as any).exports?.['pma-voice'] ?? (exports as any)['pma-voice'];

/**
 * Whether the server has connected this player into a call and not yet torn it down --
 * set by `accepted`, cleared by `ended` and `failed`, never by anything the page says.
 * A mirror of the server's call state for the `IsInCall` export (MICA-232), not a second
 * source of truth: nothing on the server reads it. Dialing and ringing are not "in call".
 */
let connected = false;

export const isInCall = (): boolean => connected;

// NUI Callbacks
RegisterNuiCallbackType('startCall');
on('__cfx_nui:startCall', (data: { number: string }, cb: Function) => {
  TriggerServerEvent('mica:server:phone:start', data.number);
  cb({ status: 'dialing' });
});

RegisterNuiCallbackType('answerCall');
on('__cfx_nui:answerCall', (_: any, cb: Function) => {
  TriggerServerEvent('mica:server:phone:answer');
  cb({ status: 'connected' });
});

RegisterNuiCallbackType('endCall');
on('__cfx_nui:endCall', (_: any, cb: Function) => {
  // The server's teardown sends `ended` to both parties, this one included, and that is
  // what reliably clears the flag. Clearing it here as well means a hang-up takes effect at
  // once rather than a round trip later. Only ever to false: the page can end a call, never
  // start one. The pma-voice channel is the server's to leave (MICA-341), on `phone:end`.
  connected = false;
  stopListening();
  TriggerServerEvent('mica:server:phone:end');
  cb({ status: 'idle' });
});

// Declining an incoming call is the same client-side action as hanging up: the server
// tears the call down for both parties. Was called by the incoming-call toast and by
// Settings' DevTools but registered nowhere, so declining silently did nothing.
RegisterNuiCallbackType('rejectCall');
on('__cfx_nui:rejectCall', (_: any, cb: Function) => {
  TriggerServerEvent('mica:server:phone:end');
  cb({ status: 'idle' });
});

// Settings > Developer Tools' "Simulate Incoming Call", in game. Admin-gated
// server-side (`mica:server:phone:simulateIncoming`) independently of the DevTools
// unlock, which is a display gate only.
RegisterNuiCallbackType('simulateIncomingCall');
on('__cfx_nui:simulateIncomingCall', (data: { number?: string }, cb: Function) => {
  TriggerServerEvent('mica:server:phone:simulateIncoming', data?.number);
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

// The speaker toggle itself is not here: it is the contracted `phone:speaker` action
// (`shared/contracts/phone.ts`), relayed like any other service call, because the server
// decides who hears the call and the phone shows its answer (MICA-246). What lives here is
// the other end of it — this player standing near somebody else's phone.

/**
 * The call volume this player had before a nearby speaker lowered it, or null while not
 * listening. Restored exactly once, by whichever of `speakerListen: false`, this player's
 * own call connecting, or this resource stopping comes first.
 */
let savedCallVolume: number | null = null;

const stopListening = (): void => {
  if (savedCallVolume === null) return;
  const restore = savedCallVolume;
  savedCallVolume = null;
  try {
    pmaVoice()?.setCallVolume?.(restore);
  } catch {
    // pma-voice gone; there is no volume left to restore.
  }
};

/**
 * A bystander's half of speakerphone (MICA-246). The server has already put this player in
 * the call's pma-voice channel, or taken them out; this only sets how loud the call is while
 * they are in it. pma-voice has one call volume per client, so it is saved and put back
 * rather than set per talker. When the current volume cannot be read it is left alone: the
 * call is then heard at the player's own call volume, which is louder than asked but never
 * a volume that cannot be undone.
 *
 * Carries no number and no name — a bystander is not told whose call they are hearing.
 */
onNet('mica:client:phone:speakerListen', (data: { listening?: boolean; volume?: number }) => {
  if (!data?.listening) {
    stopListening();
    return;
  }

  const volume = Number(data.volume);
  if (!Number.isFinite(volume)) return;
  try {
    const voice = pmaVoice();
    if (savedCallVolume === null) {
      const current = Number(voice?.getCallVolume?.());
      if (!Number.isFinite(current)) return;
      savedCallVolume = current;
    }
    voice?.setCallVolume?.(Math.min(100, Math.max(0, Math.round(volume))));
  } catch {
    // pma-voice absent or a different version; heard at the default call volume instead.
  }
});

on('onResourceStop', (resource: string) => {
  if (resource === GetCurrentResourceName()) stopListening();
});

/**
 * The server switched this phone's speaker off mid-call because it can no longer carry one
 * (pma-voice stopped, the range set to 0). Re-sent as `connected` with the speaker withdrawn,
 * which the shell reads as "hide the control and show it off" — and only while this player
 * really is on a call, so a late push can never turn an idle phone back into a call screen.
 */
onNet('mica:client:phone:speakerState', (data: { available?: boolean }) => {
  if (!connected || data?.available !== false) return;
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'connected', speakerAvailable: false }
    })
  );
});

/** `line` names the job line a call came in through (MICA-307); absent on an ordinary call. */
interface IncomingCall {
  from: string;
  callId: number;
  line?: { number: string; label: string };
}

// Server Events
onNet('mica:client:phone:incoming', (data: IncomingCall) => {
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
        name: 'Unknown',
        // So the ring can say "via 911". Passed on only when whole, and absent otherwise.
        ...(typeof data.line?.number === 'string' && typeof data.line.label === 'string'
          ? { line: { number: data.line.number, label: data.line.label } }
          : {})
      }
    })
  );
});

/**
 * The server has connected this player's call, and has already put them in its pma-voice
 * channel itself (MICA-341). The client does not join: pma-voice's client join is its
 * `pma-voice:setPlayerCall` net event, which any client can send for any channel, and a
 * channel the server places both parties in is the one a modified client cannot talk its
 * way into.
 */
onNet('mica:client:phone:accepted', (data: { callId: number; speaker?: boolean }) => {
  connected = true;
  // A call of this player's own replaces any speaker they were listening to; the server
  // lets go of them too, and this puts their own call back at their own volume first.
  stopListening();

  // Update UI. `speakerAvailable` is the server's word on whether this call can go on
  // speaker at all; the phone hides the control when it is false (MICA-246).
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'connected', speakerAvailable: data?.speaker === true }
    })
  );
});

onNet('mica:client:phone:ended', () => {
  connected = false;
  // The server has taken this player out of whatever pma-voice channel they were in, a
  // nearby speaker's included (MICA-341) — a bystander whose own dial was refused lands here
  // without ever connecting. The volume comes back now (MICA-246).
  stopListening();

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
// and there is nothing here to undo.
onNet('mica:client:phone:failed', () => {
  connected = false;

  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'idle' }
    })
  );
});
