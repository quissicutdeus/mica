import { ClientApp } from '../lib/ClientApp';

const app = new ClientApp('contacts');

app.registerCallback('getContacts', 'gphone:server:contacts:get');
app.registerCallback('createContact', 'gphone:server:contacts:create');
app.registerCallback('updateContact', 'gphone:server:contacts:update');
app.registerCallback('deleteContact', 'gphone:server:contacts:delete');

// Register manual NUI callback for client-side logic
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
