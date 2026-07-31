import { ClientApp } from '../lib/ClientApp';

const app = new ClientApp('messages');

app.registerCallback('getMessages', 'gphone:server:messages:get');
app.registerCallback('sendMessage', 'gphone:server:messages:send');
