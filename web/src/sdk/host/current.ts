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
 * `guard.ts`, `system.ts` or `createInProcessHost.ts`. That is what breaks the import cycle
 * those four files would otherwise sit on: nothing in this graph needs to import a facet
 * module (which imports `shell/`) to build a `Host`.
 *
 * What fills it is the **entry point**, not the hook (MICA-176). A bundle imports exactly
 * one of `host/inProcess/registerFacets` (the shell, from `src/main.ts`) or
 * `host/iframe/registerFacets` (an add-on, from `bootAddOn`), and that import is the only
 * thing deciding whether a facet name answers with the shell-backed implementation or its
 * sandboxed twin. Before that ticket each hook pulled its own facet on by a side-effect
 * import and a `resolveId` plugin rewrote the specifier for the add-on build, which meant
 * the same source line resolved two ways and no one could read which from the source.
 */
const facetRecord: Partial<Facets> = {};

/** Register (or replace) the implementation of one named facet. */
function registerFacet<K extends keyof Facets>(name: K, fn: Facets[K]): void {
  facetRecord[name] = fn;
}

/**
 * The live facet surface every `Host` shares. Reading a facet that has not registered
 * itself yet — this bundle imported neither `registerFacets` set — throws rather than
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
      /**
       * Names the fix, deliberately. Since MICA-176 a hook no longer carries its facet, so
       * "the hook was never imported" would send the reader to the wrong file — the answer is
       * always that this bundle never picked a facet set. The overwhelmingly common case is a
       * new unit test, which has neither entry point, so that instruction goes first.
       */
      throw new Error(
        `[gPhone] host facet '${String(name)}' is not loaded — nothing has registered a facet ` +
          `set in this bundle. A unit test must import 'sdk/host/inProcess/registerFacets' as ` +
          `its first import (it stands in for the shell). The shell itself does that from ` +
          `src/main.ts and an add-on gets 'sdk/host/iframe/registerFacets' from bootAddOn, so ` +
          `seeing this outside a test means an entry point lost its import — or that this facet ` +
          `module is missing from the set it belongs to, which sdk/seam.test.ts checks.`
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
 * at import time, when the file's `registerFacets` import pulls them on, and
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
