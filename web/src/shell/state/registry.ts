import { get, writable } from 'svelte/store';
// Imported from their own files rather than the `@gphone/sdk` barrel: that barrel
// re-exports every hook, including `useAppLevels`/`useKeybinds`, which import
// `./keybinds.ts`, which imports `appRegistryStore` from this file — going through the
// barrel here would close that cycle and leave `appRegistryStore` unset when `keybinds.ts`
// evaluates its module-level `derived(appRegistryStore, ...)`.
import { type AppComponent, type AppManifest, defineApp } from '../../sdk/manifest';
import { clearAppStorage } from '../../sdk/hooks/useStorage';
import { messageOf } from '../../lib/errors';
import { usePersisted } from '../../sdk/hooks/usePersisted';
import { placeOnHomeGridIfAbsent } from './homeGrid';

export type { AppManifest } from '../../sdk/manifest';

/**
 * Manifests eagerly, components lazily, and the split is the point.
 *
 * A manifest is small and the launcher cannot paint without one — name, icon, colour,
 * badge, whether the app is core. They are also safe to load early now: every manifest
 * imports `@gphone/sdk/app`, a leaf, rather than the barrel this module is part of.
 *
 * A component is the whole app. Loading all thirteen at boot means parsing every screen of
 * every app before the phone draws anything, and it does not scale — thirty apps would
 * cost thirty apps of startup for the one a player opens. Lazy makes that on-demand, which
 * is also what puts a bundled app on the **same** loading path as one installed from the
 * Store: both arrive as a promise resolved when the app is opened, rather than one being
 * baked in and the other fetched.
 */
const manifestFiles = import.meta.glob('../../apps/*/manifest.ts', { eager: true });
const appComponents = import.meta.glob('../../apps/*/index.svelte');

const FIRST_BOOT_KEY = 'gphone_first_boot_time';

export function getFirstBootTime(): string {
  if (typeof localStorage === 'undefined') {
    return '2026-01-01T00:00:00.000Z';
  }
  try {
    let stored = localStorage.getItem(FIRST_BOOT_KEY);
    if (!stored) {
      stored = new Date().toISOString();
      localStorage.setItem(FIRST_BOOT_KEY, stored);
    }
    return stored;
  } catch {
    return new Date().toISOString();
  }
}

const firstBoot = getFirstBootTime();

// Parse manifests
const loadedApps: AppManifest[] = [];
/** In-repo apps shipping `core: false` — present in the tree, absent from the launcher. */
const addOns: AppManifest[] = [];

/**
 * What this build ships, from the glob above. **Never written to after startup.**
 *
 * Split from the runtime registry below, and the split is the fix for a real defect: there was
 * one map, so `unregisterApp` deleting from it deleted the only reference to code that is still
 * sitting in the bundle. Uninstalling a bundled add-on and installing it again then found no
 * component, and the Store's `getComponent(id) || placeholderComponent()` handed the registry the
 * "Not part of this build" screen — for an app whose code had never left. In CEF the page never
 * unloads, so it stayed wrong for the rest of the session rather than until a refresh.
 *
 * The two maps are genuinely different facts. This one is what the resource contains; the other
 * is what has been installed since boot. A remote app's component belongs only to the second,
 * because its code came from a URL and really is gone once uninstalled.
 */
const bundledComponents: Record<string, () => Promise<unknown>> = {};

/**
 * Components that have finished loading, bundled or remote.
 *
 * `getComponent` has to answer synchronously — Svelte renders `{#if AppComponent}` and
 * cannot await — so the loader's result is cached here and the render reads the cache.
 * Nothing evicts it: a component is code, the CEF page never unloads, and re-parsing an
 * app the player has already opened once is exactly the cost this change removes.
 */
const loadedComponents: Record<string, AppComponent> = {};

/** Loads in flight, so opening an app twice in quick succession imports it once. */
const loading: Record<string, Promise<AppComponent | undefined>> = {};

/** Registered since boot: a reinstall, or a remote bundle. Cleared by `unregisterApp`. */
const componentRegistry: Record<string, AppComponent> = {};

/** Runtime registration wins, so a remote app may shadow a bundled id; the bundle is fallback. */
const resolveComponent = (appId: string): AppComponent | undefined =>
  componentRegistry[appId] ?? loadedComponents[appId];

/**
 * Whether an app exists at all, as opposed to whether its code has arrived yet.
 *
 * The two were the same question while every component was loaded at boot, and they are
 * not any more. `openApp` needs this one: refusing an app because its chunk is still in
 * flight would make opening it a race.
 */
const isKnownApp = (appId: string): boolean =>
  Boolean(componentRegistry[appId] || bundledComponents[appId] || loadedComponents[appId]);

/**
 * Fetch an app's component, once.
 *
 * Resolves to `undefined` for an id nothing declares, which is what `openApp`'s guard
 * turns into a refusal. A failed import is logged and cached as a miss rather than
 * retried on every render — a chunk that will not load is not going to start.
 */
const loadComponent = async (appId: string): Promise<AppComponent | undefined> => {
  const already = resolveComponent(appId);
  if (already) return already;

  const loader = bundledComponents[appId];
  if (!loader) return undefined;

  loading[appId] ??= loader()
    .then((module) => {
      const component = (module as { default: AppComponent }).default;
      loadedComponents[appId] = component;
      return component;
    })
    .catch((error) => {
      console.error(
        `gPhone App Registry: failed to load '${appId}'`,
        messageOf(error, 'unknown error')
      );
      return undefined;
    });

  return loading[appId];
};

for (const path in manifestFiles) {
  const rawManifest = (manifestFiles[path] as any).default as AppManifest;
  if (rawManifest && rawManifest.id) {
    const manifest = defineApp({
      installedAt: firstBoot,
      updatedAt: firstBoot,
      ...rawManifest
    });
    // Find corresponding component
    const componentPath = path.replace('manifest.ts', 'index.svelte');
    if (import.meta.env.DEV && bundledComponents[manifest.id]) {
      // Two manifest files claiming one id. The second silently replaced the first's
      // component while both stayed listed in the launcher, so one of the two icons opened
      // the other app and nothing said why.
      console.warn(
        `gPhone App Registry: '${manifest.id}' is declared by more than one app in apps/. ` +
          `The last one loaded wins, and ids are also storage namespaces — rename one.`
      );
    }
    if (appComponents[componentPath]) {
      // The loader, not the component. Called when the app is first opened.
      bundledComponents[manifest.id] = appComponents[componentPath] as () => Promise<unknown>;
    }

    // Core apps start installed on OS startup.
    // Add-on apps start uninstalled by default to allow installation/uninstallation via App Store.
    if (manifest.core) {
      loadedApps.push(manifest);
    } else {
      addOns.push(manifest);
    }
  }
}
loadedApps.sort((a, b) => a.name.localeCompare(b.name));

export const registeredApps = loadedApps;

/**
 * The add-ons this repo ships, for the Store to offer.
 *
 * Derived rather than listed. `CATALOG_APPS` used to carry a hand-written copy of each
 * one's manifest, so Notes appeared in the Store only because somebody had duplicated it
 * there — and the copy then drifted from the real thing.
 */
export const bundledAddOns = [...addOns].sort((a, b) => a.name.localeCompare(b.name));

const CORE_APP_IDS = new Set(loadedApps.filter((a) => a.core).map((a) => a.id));
const LOCAL_STORAGE_KEY = 'gphone_installed_remote_apps';

function getSavedRemoteAppUrls(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRemoteAppUrl(url: string) {
  if (typeof localStorage === 'undefined') return;
  try {
    const current = getSavedRemoteAppUrls();
    if (!current.includes(url)) {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify([...current, url]));
    }
  } catch {
    // Ignore localStorage quota/access errors
  }
}

function removeSavedRemoteAppUrl(url: string) {
  if (typeof localStorage === 'undefined') return;
  try {
    const current = getSavedRemoteAppUrls();
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(current.filter((u) => u !== url)));
  } catch {
    // Ignore errors
  }
}

const addOnIds = new Set(addOns.map((a) => a.id));

/** Drop anything that is not a string id this build actually ships as an add-on. */
const sanitizeInstalledAddOnIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === 'string' && addOnIds.has(v)))]
    : [];

/**
 * Bundled add-ons the player installed from the Store, character-scoped.
 *
 * Unlike `LOCAL_STORAGE_KEY` above (the remote-app URL list — machine-scoped, raw
 * localStorage), this rides `usePersisted`/`gphone_settings` so an install follows the
 * character rather than the PC, consistent with every other preference in the phone.
 * Namespaced under `'store'`, the app that owns this bookkeeping — not `'settings'` (a
 * phone-wide preference) and not the add-on's own id (its own namespace is its data, not
 * the Store's record that it is installed). Safe: the Store app itself is `core: true`, so
 * `unregisterApp`/`clearAppStorage` can never target this namespace.
 */
const installedAddOnIds = usePersisted<string[]>('store', 'installedAddOns', [], {
  sanitize: sanitizeInstalledAddOnIds
});

// Reactive App Registry Store for Dynamic Community App Installation
function createAppRegistry() {
  const installed = writable<AppManifest[]>(loadedApps);
  const { subscribe, update } = installed;

  const store = {
    subscribe,
    registerApp: (manifest: AppManifest, component: AppComponent) => {
      const validatedManifest = defineApp(manifest);

      if (
        CORE_APP_IDS.has(validatedManifest.id) &&
        !loadedApps.some((a) => a.id === validatedManifest.id)
      ) {
        throw new Error(
          `gPhone App Registry error: Overwriting core app '${validatedManifest.id}' is prohibited.`
        );
      }

      if (import.meta.env.DEV && get(installed).some((a) => a.id === validatedManifest.id)) {
        console.warn(
          `gPhone App Registry: '${validatedManifest.id}' is already registered and is ` +
            `being replaced. Expected when reinstalling that app; a bug if this is a ` +
            `different one claiming a taken id.`
        );
      }

      componentRegistry[validatedManifest.id] = component;
      let isNewRegistration = false;
      update((apps) => {
        const existingIndex = apps.findIndex((a) => a.id === validatedManifest.id);
        isNewRegistration = existingIndex < 0;
        const now = new Date().toISOString();
        let updated: AppManifest[];
        if (existingIndex >= 0) {
          const existing = apps[existingIndex];
          const appWithDates: AppManifest = {
            ...validatedManifest,
            installedAt: validatedManifest.installedAt || existing.installedAt || now,
            updatedAt: validatedManifest.updatedAt || now
          };
          updated = [...apps];
          updated[existingIndex] = appWithDates;
        } else {
          const defaultTime = validatedManifest.core ? getFirstBootTime() : now;
          const appWithDates: AppManifest = {
            installedAt: defaultTime,
            updatedAt: defaultTime,
            ...validatedManifest
          };
          updated = [...apps, appWithDates];
        }
        return updated.sort((a, b) => a.name.localeCompare(b.name));
      });

      // Bundled add-ons only — never a remote app (which has its own URL-based
      // persistence and must not be double-tracked), and never an id outside this
      // build (e.g. a test's ad-hoc manifest). Guarded so re-registering an id already
      // marked installed — including the rehydration below — does not fire a redundant
      // write, since `usePersisted`'s `update` always persists.
      if (!validatedManifest.isRemote && addOnIds.has(validatedManifest.id)) {
        if (!get(installedAddOnIds).includes(validatedManifest.id)) {
          installedAddOnIds.update((ids) => [...ids, validatedManifest.id]);
        }
      }

      /**
       * A player installing an add-on expects to find it on the home screen without
       * also having to know the App Drawer exists — unlike a core app, which starts in
       * the drawer only and stays there until dragged out (the home screen has no
       * default placements at all). This covers what `registerApp` itself introduces: a
       * Store install, a remote app, or (in dev) the harness registering an app the repo
       * does not ship — `error_boundary.spec.ts`'s crashing fixture, which has always
       * expected to be clickable without opening the drawer (see `devHarness.ts`).
       *
       * Gated on `isNewRegistration`, not on `addOnIds`/`isRemote`/an install-tracking
       * list: a boot-time re-registration of an add-on the player already positioned —
       * or deliberately removed — must not move it, and `placeOnHomeGridIfAbsent` is
       * itself the guard against placing an app that already has a cell.
       */
      if (!validatedManifest.core && isNewRegistration) {
        placeOnHomeGridIfAbsent(validatedManifest.id);
      }
    },
    unregisterApp: (appId: string) => {
      let currentApps: AppManifest[] = [];
      subscribe((apps) => (currentApps = apps))();
      const targetApp = currentApps.find((a) => a.id === appId);

      /**
       * Both halves matter. `CORE_APP_IDS` is the boot-time set, which catches an app that
       * is core but somehow absent from the store; `targetApp.core` catches one registered
       * after boot. An app registered at runtime claiming to be core used to reach only the
       * second check, and `defineApp` would happily have handed it `core: true` — which is
       * why the remote path is now normalized there rather than trusted here.
       */
      if (CORE_APP_IDS.has(appId) || targetApp?.core) {
        throw new Error(
          `gPhone App Registry error: Unregistering core app '${appId}' is prohibited.`
        );
      }
      if (targetApp?.bundleUrl) {
        removeSavedRemoteAppUrl(targetApp.bundleUrl);
      } else {
        installedAddOnIds.update((ids) => ids.filter((id) => id !== appId));
      }
      /**
       * The runtime map only. A bundled add-on's component stays where the glob put it, because
       * uninstalling an app does not remove its code from the resource — and deleting it there
       * is what made a reinstall mount the "not part of this build" placeholder.
       */
      delete componentRegistry[appId];
      clearAppStorage(appId);
      update((apps) => apps.filter((a) => a.id !== appId));
    },
    getComponent: (appId: string): AppComponent | undefined => resolveComponent(appId),
    /** Whether the app exists, regardless of whether its chunk has arrived. */
    isKnownApp,
    /** Fetch an app's component. Idempotent, and the only thing that imports app code. */
    loadComponent,
    /**
     * The manifest for an installed app.
     *
     * The shell holds app *ids*; anything shown to a player needs the manifest's `name`.
     * Without this the error boundary rendered the id rather than the manifest's
     * `name`, which are not the same string.
     */
    getManifest: (appId: string): AppManifest | undefined =>
      get(installed).find((a: AppManifest) => a.id === appId),
    loadRemoteApp: async (url: string): Promise<{ manifest: AppManifest; component: any }> => {
      if (!url || typeof url !== 'string') {
        throw new Error('gPhone App Loader error: Remote app URL must be a valid string.');
      }

      let loadedModule: any;
      try {
        // Try direct dynamic import
        loadedModule = await import(/* @vite-ignore */ url);
      } catch (directImportError) {
        // CEF / Fallback: Fetch bundle code and import via data URL
        try {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }
          const code = await response.text();
          const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
          loadedModule = await import(/* @vite-ignore */ dataUrl);
        } catch (fallbackError) {
          const why = messageOf(directImportError, '') || messageOf(fallbackError, 'unknown error');
          throw new Error(`gPhone Remote App Loader failed to load bundle from '${url}': ${why}`);
        }
      }

      const rawManifest =
        loadedModule.manifest ||
        loadedModule.default?.manifest ||
        (loadedModule.default &&
        typeof loadedModule.default === 'object' &&
        'id' in loadedModule.default
          ? loadedModule.default
          : null);

      const component =
        loadedModule.component ||
        loadedModule.default?.component ||
        (typeof loadedModule.default === 'function' || typeof loadedModule.default === 'object'
          ? loadedModule.default
          : null);

      if (!rawManifest) {
        throw new Error(
          `gPhone Remote App Loader error: Module at '${url}' does not export a valid 'manifest'.`
        );
      }

      if (!component) {
        throw new Error(
          `gPhone Remote App Loader error: Module at '${url}' does not export a valid Svelte 'component'.`
        );
      }

      const validatedManifest = defineApp({
        ...rawManifest,
        isRemote: true,
        bundleUrl: url
      });

      store.registerApp(validatedManifest, component);
      saveRemoteAppUrl(url);

      return { manifest: validatedManifest, component };
    }
  };

  // Rehydrate saved remote apps on startup if running in browser/client environment
  if (typeof window !== 'undefined') {
    const savedUrls = getSavedRemoteAppUrls();
    for (const url of savedUrls) {
      store.loadRemoteApp(url).catch((err) => {
        console.warn(`gPhone Registry failed to re-hydrate remote app from '${url}':`, err);
      });
    }

    /**
     * Re-register every previously installed bundled add-on.
     *
     * `subscribe` rather than a one-shot loop like the remote-URL rehydration above:
     * unlike that raw-localStorage read, `installedAddOnIds` is a live `usePersisted`
     * store, so one subscription covers both boot (fires immediately with the current
     * value) and a later character switch (`usePersisted`'s own rehydrate-on-server-copy
     * pushes a new value, which re-fires this subscription).
     */
    installedAddOnIds.subscribe((ids) => {
      for (const id of ids) {
        if (get(installed).some((a) => a.id === id)) continue;
        const manifest = addOns.find((a) => a.id === id);
        if (!manifest) continue; // no longer part of this build
        loadComponent(id)
          .then((component) => {
            if (!component) return; // build doesn't have it after all
            store.registerApp(manifest, component);
          })
          .catch((err) => {
            console.warn(`gPhone Registry failed to re-hydrate installed add-on '${id}':`, err);
          });
      }
    });
  }

  return store;
}

export const appRegistryStore = createAppRegistry();
