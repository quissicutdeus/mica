// Messages: only the part that is not a plain relay. The CRUD routes are declared in
// `shared/routes.ts` and registered by the relay.

import { sendNuiMessage } from '../lib/nui';

/**
 * An inbound text.
 *
 * The server pushes this to every other participant when someone sends. Nothing existed
 * before — `send` wrote the row and told no one — so a text never arrived on its own.
 *
 * `receiveMessage` is the shell's existing route: it adds the message to the thread and
 * raises a toast with an inline reply. It was already wired and simply never fired.
 */
onNet('gphone:client:messages:received', (payload: unknown) => {
  const data = payload as { conversation_id?: number } | null;
  if (!data?.conversation_id) return;
  sendNuiMessage('receiveMessage', data);
});
