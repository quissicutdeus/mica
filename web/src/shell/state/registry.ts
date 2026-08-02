import { get, writable } from 'svelte/store';
import { type AppManifest, defineApp } from '@gphone/sdk';
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
const componentRegistry: Record<string, any> = {};

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
    if (appComponents[componentPath]) {
      componentRegistry[manifest.id] = (appComponents[componentPath] as any).default;
    }

    // System core apps start installed on OS startup.
    // Community add-on apps start uninstalled by default to allow installation/uninstallation via App Store.
    if (manifest.isSystem !== false) {
      loadedApps.push(manifest);
    }
  }
}
loadedApps.sort((a, b) => a.name.localeCompare(b.name));

export const registeredApps = loadedApps;

const SYSTEM_APP_IDS = new Set(loadedApps.filter((a) => a.isSystem !== false).map((a) => a.id));
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
    registerApp: (manifest: AppManifest, component: any) => {
      const validatedManifest = defineApp(manifest);

      if (
        SYSTEM_APP_IDS.has(validatedManifest.id) &&
        !loadedApps.some((a) => a.id === validatedManifest.id)
      ) {
        throw new Error(
          `gPhone App Registry error: Overwriting system app '${validatedManifest.id}' is prohibited.`
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
          const isSystem = validatedManifest.isSystem !== false;
          const defaultTime = isSystem ? getFirstBootTime() : now;
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

      let isSystemApp = SYSTEM_APP_IDS.has(appId);
      if (targetApp && targetApp.isSystem !== false) {
        isSystemApp = true;
      }
      if (isSystemApp) {
        throw new Error(
          `gPhone App Registry error: Unregistering system app '${appId}' is prohibited.`
        );
      }
      if (targetApp?.bundleUrl) {
        removeSavedRemoteAppUrl(targetApp.bundleUrl);
      }
      delete componentRegistry[appId];
      update((apps) => apps.filter((a) => a.id !== appId));
    },
    getComponent: (appId: string) => componentRegistry[appId],
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
