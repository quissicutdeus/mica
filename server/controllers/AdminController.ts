import { ServerApp } from '../lib/ServerApp';

/**
 * Whether the calling player holds the `gphone.admin` ace.
 *
 * Ace checks are only authoritative on the server. The client-side native reflects what
 * the server last told this client and is spoofable, so anything gated on admin has to
 * ask here — and, per AGENTS.md §2.9, has to enforce the gate at the privileged action
 * too. This endpoint decides what the UI *shows*; it is not the boundary.
 */
const app = new ServerApp<never>('admin', null, {
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

export const isAdmin = (source: number): boolean =>
  IsPlayerAceAllowed(String(source), 'gphone.admin');

app.registerEvent('check', async (source) => ({ isAdmin: isAdmin(source) }));
