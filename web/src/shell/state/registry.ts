import { get, writable } from 'svelte/store';
import { type AppComponent, type AppManifest, clearAppStorage, defineApp } from '@gphone/sdk';
import { messageOf } from '../../lib/errors';

export type { AppManifest } from '@gphone/sdk';

// Glob every app's manifest and component out of `apps/`.
const manifestFiles = import.meta.glob('../../apps/*/manifest.ts', { eager: true });
const appComponents = import.meta.glob('../../apps/*/index.svelte', { eager: true });

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
const bundledComponents: Record<string, AppComponent> = {};

/** Registered since boot: a reinstall, or a remote bundle. Cleared by `unregisterApp`. */
const componentRegistry: Record<string, AppComponent> = {};

/** Runtime registration wins, so a remote app may shadow a bundled id; the bundle is fallback. */
const resolveComponent = (appId: string): AppComponent | undefined =>
  componentRegistry[appId] ?? bundledComponents[appId];

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
      bundledComponents[manifest.id] = (appComponents[componentPath] as any).default;
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

      if (import.meta.env.DEV && resolveComponent(validatedManifest.id)) {
        console.warn(
          `gPhone App Registry: '${validatedManifest.id}' is already registered and is ` +
            `being replaced. Expected when reinstalling that app; a bug if this is a ` +
            `different one claiming a taken id.`
        );
      }

      componentRegistry[validatedManifest.id] = component;
      update((apps) => {
        const existingIndex = apps.findIndex((a) => a.id === validatedManifest.id);
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
       * why the remote path is now normalised there rather than trusted here.
       */
      if (CORE_APP_IDS.has(appId) || targetApp?.core) {
        throw new Error(
          `gPhone App Registry error: Unregistering core app '${appId}' is prohibited.`
        );
      }
      if (targetApp?.bundleUrl) {
        removeSavedRemoteAppUrl(targetApp.bundleUrl);
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
  }

  return store;
}

export const appRegistryStore = createAppRegistry();
