// Contacts: only the part that is not a plain relay. The CRUD routes are declared in
// `shared/routes.ts` and registered by RelayController.

RegisterNuiCallbackType('shareContact');
on(
  '__cfx_nui:shareContact',
  (
    data: { name: string; phone: string; avatar?: string; firstname?: string; lastname?: string },
    cb: Function
  ) => {
    // Proximity logic to share contact payload with nearby players
    console.log(
      `Sharing contact [${data.name || data.firstname} - ${data.phone}] (Avatar: ${data.avatar ? 'Yes' : 'None'}) with nearby players...`
    );

    // In production, locate nearby players and trigger server event with payload (name, phone, avatar)
    cb({ success: true });
  }
);
