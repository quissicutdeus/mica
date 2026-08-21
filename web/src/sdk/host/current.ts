import type { Host } from './protocol';

/**
 * All mutable host state lives here, and only here. `guard.ts`, `system.ts` and
 * `createInProcessHost.ts` have no module-level `const`/`let` state of their own — this
 * file imports only `./protocol` (a type), so nothing that imports `shell/`, `services/`,
 * `nui/` or `inProcess/` sits on the module graph between `guard.ts` and the state it
 * reads. That is what keeps `guard.ts` safe to import from module scope (e.g.
 * `useStorage.ts`) once `createInProcessHost` starts importing files that import
 * `shell/`, which import `useStorage` — see Task 2.
 */
const hosts = new Map<string, Host>();
let system: Host | undefined;
const warnedHooks = new Set<string>();

/** Register (or replace) the `Host` for an appId. */
function registerHost(host: Host): void {
  hosts.set(host.appId, host);
}

/** Look up a registered `Host` by appId. */
function hostFor(appId: string): Host | undefined {
  return hosts.get(appId);
}

/** Set the system host — the fallback used when no app-scoped host applies. */
function setSystemHost(host: Host): void {
  system = host;
}

/** The system host. Throws if `setSystemHost` has not run yet — boot must set it. */
function systemHost(): Host {
  if (!system) {
    throw new Error('systemHost() called before setSystemHost() — boot must set it first.');
  }
  return system;
}

/**
 * Records that `guarded()` has warned about falling back to the system host for
 * `hookName`. Returns `true` the first time it's called for a given hook, `false` on
 * every call after — so `guarded()` can warn exactly once per hook.
 */
function markSystemHostWarned(hookName: string): boolean {
  if (warnedHooks.has(hookName)) return false;
  warnedHooks.add(hookName);
  return true;
}

/** @internal Test-only: clears the registry, system host and warned-hook set between test cases. */
function resetHostsForTest(): void {
  hosts.clear();
  system = undefined;
  warnedHooks.clear();
}

export {
  registerHost,
  hostFor,
  setSystemHost,
  systemHost,
  markSystemHostWarned,
  resetHostsForTest
};
