import type { Host } from './protocol';
import type { Facets } from './inProcess/facets';

/**
 * All mutable host state lives here, and only here. `guard.ts`, `system.ts` and
 * `createInProcessHost.ts` have no module-level `const`/`let` state of their own — this
 * file's only import of `inProcess/facets` is type-only (erased at build time), so nothing
 * that imports `shell/`, `services/`, `nui/` or `inProcess/` sits on the module graph
 * between `guard.ts` and the state it reads. That is what keeps `guard.ts` safe to import
 * from module scope (e.g. `useStorage.ts`) even once individual facet modules import
 * `shell/`, which import hooks back — see Task 2 of MICA-16 step 3.
 */
const hosts = new Map<string, Host>();
let system: Host | undefined;
const warnedHooks = new Set<string>();

/**
 * The facet registry, keyed by facet name. Populated at runtime by each facet module's
 * own `registerFacet(...)` call at its bottom — never imported directly by `current.ts`,
 * `guard.ts`, `system.ts` or `createInProcessHost.ts`. A facet is only in here once the
 * hook file that owns it has been imported somewhere on the page, which is what breaks
 * the import cycle those four files would otherwise sit on: nothing in this graph needs
 * to import a facet module (which imports `shell/`) to build a `Host`.
 */
const facetRecord: Partial<Facets> = {};

/** Register (or replace) the implementation of one named facet. */
function registerFacet<K extends keyof Facets>(name: K, fn: Facets[K]): void {
  facetRecord[name] = fn;
}

/**
 * The live facet surface every `Host` shares. Reading a facet that has not registered
 * itself yet — the hook file that owns it was never imported — throws rather than
 * silently returning `undefined`, since a `Host.facets.<name>()` call site expects a
 * function to be there.
 */
const facets: Facets = new Proxy({} as Facets, {
  get(target, prop, receiver) {
    // Symbols (`Symbol.toStringTag`, `Symbol.toPrimitive`, …) and `'then'` are not facet
    // names — they're what `String(facets)`, `console.log`, `expect(...).toEqual(...)` or
    // an `await` near the object probe for, and none of them is ever registered. Throwing
    // on those would make the registry unsafe to even look at from a debugger or a test
    // assertion. Pass them straight through to the (empty) target instead of treating them
    // as an unregistered facet.
    if (typeof prop === 'symbol' || prop === 'then') {
      // `Reflect.get` is untyped by TS's own lib.d.ts; a Proxy trap has nothing more specific to return.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return Reflect.get(target, prop, receiver);
    }
    const name = prop as keyof Facets;
    const fn = facetRecord[name];
    if (fn === undefined) {
      throw new Error(
        `[gPhone] host facet '${String(name)}' is not loaded — the hook that owns it was never imported`
      );
    }
    return fn;
  }
});

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

/**
 * @internal Test-only: clears the host registry, system host and warned-hook set between
 * test cases. Deliberately leaves `facetRecord` alone — facet modules self-register once,
 * at import time, via a side-effect import (`import './inProcess/facets/theme'`), and
 * vitest does not re-evaluate a module between test cases in the same file unless the
 * module registry itself is reset (`vi.resetModules()`). Clearing the facet record here
 * would make every host test that runs after the first one in a file throw
 * "facet is not loaded" for a facet the file's own top-level imports already registered.
 */
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
  resetHostsForTest,
  registerFacet,
  facets
};
