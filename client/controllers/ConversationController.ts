import { ClientApp } from '../lib/ClientApp';

const app = new ClientApp('conversations');

app.registerCallback('getConversations', 'gphone:server:conversations:get');
app.registerCallback('startConversation', 'gphone:server:conversations:create');
app.registerCallback('deleteConversation', 'gphone:server:conversations:delete');
app.registerCallback('leaveConversation', 'gphone:server:conversations:delete');
app.registerCallback('readConversation', 'gphone:server:conversations:read');
// Rename rides the generic update: `clientWritable` on the conversations repo is
// ['name'], and `update` is ownership-scoped, so only the creator can rename.
app.registerCallback('renameConversation', 'gphone:server:conversations:update');

// 'read' is a custom action, so its response lands on `...:read` rather than one of
// the four names ClientApp listens for by default.
app.registerResponseListener('read');
