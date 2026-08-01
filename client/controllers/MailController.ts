// Mail: only the part that is not a plain relay. The CRUD routes are declared in
// `shared/routes.ts` and registered by RelayController.

onNet('gphone:client:mail:receive', (newMail: any) => {
  SendNuiMessage(
    JSON.stringify({
      action: 'receiveMail',
      data: newMail
    })
  );
});
