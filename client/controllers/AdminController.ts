import { ClientApp } from '../lib/ClientApp';

const app = new ClientApp('admin');

app.registerCallback('checkAdmin', 'gphone:server:admin:check');
