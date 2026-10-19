// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { adminContract } from '@mica/shared/contracts/admin';

/**
 * Whether the caller counts as an admin.
 *
 * Ace checks are only authoritative on the server. The client-side native reflects what
 * the server last told this client and is spoofable, so anything gated on admin has to
 * ask here — and, per AGENTS.md §2.9, has to enforce the gate at the privileged action
 * too. This endpoint decides what the UI *shows*; it is not the boundary.
 */

/**
 * Aces that grant micaOS admin, in order of specificity.
 *
 * `mica.admin` alone was wrong: a server owner who is already a full admin had to
 * grant themselves a second, micaOS-specific ace before the phone would believe them,
 * which reads as the resource being broken rather than strict.
 *
 * `command` is the standard proxy for "runs this server" — `add_ace group.admin command
 * allow` is the near-universal setup, and anyone holding it can already do anything the
 * phone's Developer Tools offer, by console. Recognising it grants nothing new.
 *
 * `mica.admin` remains for granting phone admin to someone who is *not* a server
 * admin, which is the case the dedicated ace actually exists for.
 *
 * Note ace objects are hierarchical, so allowing `mica` covers `mica.admin` already
 * — there is no need to list parents here.
 */
export const DEFAULT_ADMIN_ACES = ['mica.admin', 'command'] as const;

/**
 * Override with, e.g. `setr mica_admin_aces "mica.admin,mygroup.staff"`.
 *
 * Read per check rather than cached: a server owner adjusting permissions should not
 * have to restart the resource to see it take effect.
 */
export const adminAces = (): string[] => {
  const raw = GetConvar('mica_admin_aces', DEFAULT_ADMIN_ACES.join(','));
  const parsed = raw
    .split(',')
    .map((ace) => ace.trim())
    .filter(Boolean);
  // An empty or whitespace-only convar would otherwise lock everyone out silently.
  return parsed.length > 0 ? parsed : [...DEFAULT_ADMIN_ACES];
};
const app = new ServiceEndpoint<never, typeof adminContract>('admin', null, {
  contract: adminContract,
  // Staff tools are the citizen's, not a device's: the admin app ships on both (MICA-264).
  devices: ['phone', 'tablet'],
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

/**
 * `FrameworkBridge`'s `SYNTHETIC_SOURCE_MAX`: the integration door's sources (MICA-397) are at
 * or below it. Written out rather than imported, as the door writes it: the bridge mocks in
 * `reports`, `moderationRestore`, `battery`, `mediaRetention` and `mediaStorageStats` carry no
 * such export, and every `isAdmin` call there would throw reading it. `admin.test.ts` pins the
 * two equal.
 */
const SYNTHETIC_SOURCE_MAX = -1_000_000;

export const isAdmin = (source: number): boolean => {
  // The server console has no principals and is trusted by definition.
  if (source === 0) return true;
  /**
   * A synthetic player is no connection and holds no ace; it is an admin only when the door
   * seeded it as one, which the bridge answers only on a server started with `mica_integration`
   * at `1`. Every source above the bound — a connected player, `-1`, a line call's pseudo-source
   * — takes the ace check below and never reaches this.
   */
  if (source <= SYNTHETIC_SOURCE_MAX) return FrameworkBridge.isSyntheticAdmin(source);
  return adminAces().some((ace) => IsPlayerAceAllowed(String(source), ace));
};

app.registerEvent('check', async (source) => ({ isAdmin: isAdmin(source) }));
