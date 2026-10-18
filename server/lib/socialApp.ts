// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  onAccountBlocked,
  registerAccountAppPolicy,
  unregisterAccountAppPolicy,
  unregisterAccountBlocked,
  type AccountAppPolicy
} from '../services/Accounts';
import { registerDmPolicy, unregisterDmPolicy, type DmPolicy } from '../services/DirectMessages';
import type { Account } from '@mica/shared/types';

/**
 * Everything a social app changes about the shared account and DM services (MICA-394), in one
 * object. Each field is optional and feeds one registry: `accounts` is
 * `registerAccountAppPolicy`, `dms` is `registerDmPolicy`, `onBlocked` is `onAccountBlocked`.
 * Those stay exported for a service that genuinely needs only one of them.
 */
export interface SocialApp {
  accounts?: AccountAppPolicy;
  dms?: DmPolicy;
  onBlocked?: (blocker: Account, blocked: Account) => Promise<void>;
}

/** Each defined app's undo steps, in registration order. A Map for the `__proto__` reason. */
const defined = new Map<string, (() => void)[]>();

const undoAll = (steps: readonly (() => void)[]): void => {
  for (const step of [...steps].reverse()) step();
};

/**
 * Register one social app with every registry it names. Called once, at import time, by the
 * app's own service file, so the registries never name an app.
 *
 * Throws on a second definition for the same app before touching any registry, and on one that
 * names nothing. A registry that refuses (a policy someone registered directly, a malformed id
 * or cap) has the registrations already made undone before its error is rethrown, so an app is
 * never left half-wired: a DM policy with no account cap, or a cap with no block handler.
 */
export const defineSocialApp = (appId: string, app: SocialApp): void => {
  if (defined.has(appId)) {
    throw new Error(`defineSocialApp: '${appId}' is already defined.`);
  }
  const { accounts, dms, onBlocked } = app;
  if (!accounts && !dms && !onBlocked) {
    throw new Error(`defineSocialApp: '${appId}' registers nothing.`);
  }
  const undo: (() => void)[] = [];
  try {
    if (accounts) {
      registerAccountAppPolicy(appId, accounts);
      undo.push(() => unregisterAccountAppPolicy(appId));
    }
    if (dms) {
      registerDmPolicy(appId, dms);
      undo.push(() => unregisterDmPolicy(appId));
    }
    if (onBlocked) {
      onAccountBlocked(appId, onBlocked);
      undo.push(() => unregisterAccountBlocked(appId));
    }
  } catch (error) {
    undoAll(undo);
    throw error;
  }
  defined.set(appId, undo);
};

/**
 * Test seam: forget every app `defineSocialApp` registered, in every registry it fed. A
 * registration made directly through one registry's own function is left alone.
 */
export const resetSocialAppsForTests = (): void => {
  for (const steps of defined.values()) undoAll(steps);
  defined.clear();
};
