// Mail: only the part that is not a plain relay. The CRUD routes are declared in
// `shared/routes.ts` and registered by the relay.

import { sendNuiMessage } from '../lib/nui';

onNet('gphone:client:mail:receive', (newMail: unknown) => {
  sendNuiMessage('receiveMail', newMail);
});
