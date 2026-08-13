import { PhoneState } from '../lib/PhoneState';

// Calls do not use ServiceProxy: these are fire-and-forget NUI callbacks with no cbId to
// correlate and no server reply to await, so the request/response machinery does not
// apply. They answer the NUI callback immediately and let the server push state changes
// back through the `gphone:client:*` events below.

// NUI Callbacks
RegisterNuiCallbackType('startCall');
on('__cfx_nui:startCall', (data: { number: string }, cb: Function) => {
  TriggerServerEvent('gphone:server:phone:start', data.number);
  cb({ status: 'dialing' });
});

RegisterNuiCallbackType('answerCall');
on('__cfx_nui:answerCall', (_: any, cb: Function) => {
  TriggerServerEvent('gphone:server:phone:answer');
  cb({ status: 'connected' });
});

RegisterNuiCallbackType('endCall');
on('__cfx_nui:endCall', (_: any, cb: Function) => {
  TriggerServerEvent('gphone:server:phone:end');
  cb({ status: 'idle' });
});

// Declining an incoming call is the same client-side action as hanging up: the server
// tears the call down for both parties. Was called by the incoming-call toast and by
// Settings' DevTools but registered nowhere, so declining silently did nothing.
RegisterNuiCallbackType('rejectCall');
on('__cfx_nui:rejectCall', (_: any, cb: Function) => {
  TriggerServerEvent('gphone:server:phone:end');
  cb({ status: 'idle' });
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
    exports['pma-voice']?.setPlayerTalkingOverride?.(!data?.muted);
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
onNet('gphone:client:phone:incoming', (data: { from: string; callId: number }) => {
  SetNuiFocus(true, true);
  // The phone is now open whether or not the player asked for it. Without this the flag
  // in PhoneState still reads false, so the next `M` re-opens instead of closing and
  // freelook refuses to engage.
  PhoneState.setOpen(true);
  SendNuiMessage(
    JSON.stringify({
      action: 'setVisible',
      data: true
    })
  );

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

onNet('gphone:client:phone:accepted', (data: { callId: number }) => {
  // Connect to PMA Voice Channel
  exports['pma-voice'].addPlayerToCall(data.callId);

  // Update UI
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'connected' }
    })
  );
});

onNet('gphone:client:phone:ended', () => {
  // Disconnect from PMA Voice
  exports['pma-voice'].removePlayerFromCall();

  // Update UI
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'idle' }
    })
  );
});

// If calls fail
onNet('gphone:client:phone:failed', () => {
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'idle' }
    })
  );
});
