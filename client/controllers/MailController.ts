import { ClientApp } from '../lib/ClientApp';

const app = new ClientApp('mail');

app.registerCallback('getMail', 'gphone:server:mail:getMail');
app.registerCallback('markAsRead', 'gphone:server:mail:markAsRead');
app.registerCallback('archiveMail', 'gphone:server:mail:archiveMail');
app.registerCallback('deleteMail', 'gphone:server:mail:deleteMail');

onNet('gphone:client:mail:receive', (newMail: any) => {
  SendNuiMessage(
    JSON.stringify({
      action: 'receiveMail',
      data: newMail
    })
  );
});
