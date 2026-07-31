import { ClientApp } from '../lib/ClientApp';

const app = new ClientApp('bank');

app.registerCallback('getTransactions', 'gphone:server:bank:getTransactions');
