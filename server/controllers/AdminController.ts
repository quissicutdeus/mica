import { ServerApp } from '../lib/ServerApp';

/**
 * Whether the caller counts as an admin.
 *
 * Ace checks are only authoritative on the server. The client-side native reflects what
 * the server last told this client and is spoofable, so anything gated on admin has to
 * ask here — and, per AGENTS.md §2.9, has to enforce the gate at the privileged action
 * too. This endpoint decides what the UI *shows*; it is not the boundary.
 */

/**
 * Aces that grant gPhone admin, in order of specificity.
 *
 * `gphone.admin` alone was wrong: a server owner who is already a full admin had to
 * grant themselves a second, gPhone-specific ace before the phone would believe them,
 * which reads as the resource being broken rather than strict.
 *
 * `command` is the standard proxy for "runs this server" — `add_ace group.admin command
 * allow` is the near-universal setup, and anyone holding it can already do anything the
 * phone's Developer Tools offer, by console. Recognising it grants nothing new.
 *
 * `gphone.admin` remains for granting phone admin to someone who is *not* a server
 * admin, which is the case the dedicated ace actually exists for.
 *
 * Note ace objects are hierarchical, so allowing `gphone` covers `gphone.admin` already
 * — there is no need to list parents here.
 */
export const DEFAULT_ADMIN_ACES = ['gphone.admin', 'command'] as const;

/**
 * Override with, e.g. `setr gphone_admin_aces "gphone.admin,mygroup.staff"`.
 *
 * Read per check rather than cached: a server owner adjusting permissions should not
 * have to restart the resource to see it take effect.
 */
export const adminAces = (): string[] => {
  const raw = GetConvar('gphone_admin_aces', DEFAULT_ADMIN_ACES.join(','));
  const parsed = raw
    .split(',')
    .map((ace) => ace.trim())
    .filter(Boolean);
  // An empty or whitespace-only convar would otherwise lock everyone out silently.
  return parsed.length > 0 ? parsed : [...DEFAULT_ADMIN_ACES];
};
const app = new ServerApp<never>('admin', null, {
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

export const isAdmin = (source: number): boolean => {
  // The server console has no principals and is trusted by definition.
  if (source === 0) return true;
  return adminAces().some((ace) => IsPlayerAceAllowed(String(source), ace));
};

app.registerEvent('check', async (source) => ({ isAdmin: isAdmin(source) }));
