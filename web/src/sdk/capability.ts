import { getContext } from 'svelte';
import type { AppPermission } from './manifest';

export const CAPABILITY_CONTEXT_KEY = 'app_capability_context';

export interface AppCapabilityContext {
  appId: string;
  permissions: AppPermission[];
}

/**
 * Moved to `host/protocol.ts` (MICA-16 step 3) — that's where it's actually thrown now.
 * Re-exported here so nothing that imports it from `capability.ts` breaks.
 */
export { AppPermissionError } from './host/protocol';

/**
 * Check if the currently executing app context has declared a specific capability permission.
 *
 * Defaults to system/shell permission (`allowed: true, appId: 'system'`) if called outside
 * an app component hierarchy or during non-component execution (e.g. background services/tests).
 */
export function checkCapability(permission: AppPermission): { allowed: boolean; appId: string } {
  let ctx: AppCapabilityContext | undefined;
  try {
    ctx = getContext<AppCapabilityContext>(CAPABILITY_CONTEXT_KEY);
  } catch {
    return { allowed: true, appId: 'system' };
  }

  if (!ctx) {
    return { allowed: true, appId: 'system' };
  }

  const allowed = ctx.permissions.includes(permission);
  return { allowed, appId: ctx.appId };
}

/**
 * Warn, in dev only, when an app calls a hook it hasn't declared the matching permission for.
 *
 * Deliberately does not throw. `AGENTS.md` §7 ("App permissions are a disclosure, not a
 * sandbox") is explicit that a manifest's `permissions` cannot become access control: every
 * app shares the shell's own JS context, so a check here is one an add-on can always route
 * around (`useNuiBridge`/`useService` reach the same data with no capability check at all),
 * and `permissions.test.ts` only proves *first-party* apps in this repo declare what they
 * use — it can't see a Store-installed remote app's manifest. A remote add-on that
 * under-declares a permission is a stale Store listing today; making this throw would turn
 * that into a hard crash for exactly the app category the disclosure-only design exists to
 * accommodate. The warning still gives a developer something to notice locally.
 */
export function assertCapability(permission: AppPermission, hookName: string): void {
  const { allowed, appId } = checkCapability(permission);
  if (!allowed && import.meta.env.DEV) {
    console.warn(
      `[gPhone] App '${appId}' called '${hookName}' without declaring permission '${permission}' in its manifest.`
    );
  }
}
