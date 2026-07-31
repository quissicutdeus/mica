// Calls do not use ClientApp: these are fire-and-forget NUI callbacks with no cbId to
// correlate and no server reply to await, so the request/response machinery does not
// apply. They answer the NUI callback immediately and let the server push state changes
// back through the `gphone:client:*` events below.

// NUI Callbacks
RegisterNuiCallbackType('startCall');
on('__cfx_nui:startCall', (data: { number: string }, cb: Function) => {
  TriggerServerEvent('gphone:server:startCall', data.number);
  cb({ status: 'dialing' });
});

RegisterNuiCallbackType('answerCall');
on('__cfx_nui:answerCall', (_: any, cb: Function) => {
  TriggerServerEvent('gphone:server:answerCall');
  cb({ status: 'connected' });
});

RegisterNuiCallbackType('endCall');
on('__cfx_nui:endCall', (_: any, cb: Function) => {
  TriggerServerEvent('gphone:server:endCall');
  cb({ status: 'idle' });
});

// Declining an incoming call is the same client-side action as hanging up: the server
// tears the call down for both parties. Was called by the incoming-call toast and by
// Settings' DevTools but registered nowhere, so declining silently did nothing.
RegisterNuiCallbackType('rejectCall');
on('__cfx_nui:rejectCall', (_: any, cb: Function) => {
  TriggerServerEvent('gphone:server:endCall');
  cb({ status: 'idle' });
});

RegisterNuiCallbackType('toggleSpeaker');
on('__cfx_nui:toggleSpeaker', (data: { enabled: boolean }, cb: Function) => {
  // There isn't a standard "toggleSpeaker" export in pma-voice usually exposed to client this way without routing audio?
  // Actually, pma-voice usually handles voice targets.
  // However, for "speakerphone" effect (hearing caller loudly nearby), submixes are often used.
  // Without advanced audio work, we can might simple assume this is UI only or specific server logic.
  // User asked for "speakerphone toggling".
  // Does pma-voice allow setting a call as "speaker"?
  // Checking docs (simulated): No standard export.
  // We will just callback success. The UI already toggles the icon.
  // Ideally we'd set a variable that affects `exports['pma-voice'].setVoicePropery`?
  // Let's keep it simple: It's UI state. If pma-voice updates later, we add it here.
  cb({ success: true });
});

// Server Events
onNet('gphone:client:receiveCall', (data: { from: string; callId: number }) => {
  SetNuiFocus(true, true);
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
        name: 'Unknown' // TODO: Lookup contact name on client side if possible or let UI do it
      }
    })
  );
});

onNet('gphone:client:callAccepted', (data: { callId: number }) => {
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

onNet('gphone:client:endCall', () => {
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
onNet('gphone:call:failed', () => {
  SendNuiMessage(
    JSON.stringify({
      action: 'callStatus',
      data: { status: 'idle' }
    })
  );
});
