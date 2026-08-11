// Contacts: only the part that is not a plain relay. The CRUD routes are declared in
// `shared/routes.ts` and registered by the relay.

/**
 * Proximity contact sharing.
 *
 * Fire-and-forget like `startCall` in `Call.ts`: the NUI callback resolves immediately,
 * and the server does the actual work of finding who is nearby and Bluetooth-visible.
 * The outcome — delivered to N phones, or nobody in range — reaches the sender through a
 * pushed toast rather than through this callback's reply, because that outcome is not
 * known until after the round trip to the server completes.
 */
RegisterNuiCallbackType('shareContact');
on('__cfx_nui:shareContact', (data: unknown, cb: Function) => {
  TriggerServerEvent('gphone:server:contacts:share', data);
  cb({ ok: true });
});

/**
 * The receiving half: another player's server pushed this because we were nearby and
 * Bluetooth-visible. Forwarded into the NUI the same way `receiveMail`/`receiveMessage`
 * relay a server push — `web/src/shell/nuiMessages.ts`'s `receiveContactShare` is the
 * handler already built and waiting for it.
 */
onNet('gphone:client:contacts:incoming', (payload: unknown) => {
  SendNuiMessage(JSON.stringify({ action: 'shareContact', data: payload }));
});
