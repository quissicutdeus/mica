// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
// Imported from their own files rather than the `@gphone/sdk` barrel: that barrel
// re-exports every hook, including `useAppLevels`/`useKeybinds`, which import
// `./keybinds.ts`, which imports `appRegistryStore` from this file — going through the
// barrel here would close that cycle and leave `appRegistryStore` unset when `keybinds.ts`
// evaluates its module-level `derived(appRegistryStore, ...)`.
import { type AppComponent, type AppManifest, defineApp } from '../../../../sdk/manifest';
import { clearAppStorage } from '../../../../sdk/host/useStorage';
import { messageOf } from '@gphone/sdk';
import { capabilities, capabilitiesKnown } from '../../services/capabilities';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { placeOnHomeGridIfAbsent } from './homeGrid';
import {
  getTrustedRemoteAppHosts,
  isTrustedRemoteUrl,
  matchesHash
} from '../../../../sdk/remoteAppSecurity';
import { isCatalogEntry, type CatalogEntry } from '../../../../sdk/catalog';

export type { AppManifest } from '../../../../sdk/manifest';

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
/** Every id seen so far in the glob loop below, core or not — the duplicate-id guard. */
const seenManifestIds = new Set<string>();

/**
 * What this build ships, from the glob above — **core apps only**, and **never written to
 * after startup**. An add-on never has an entry here: its code runs in a sandboxed iframe
 * from `getAddOnSource`'s fetched text, never `import()`ed by the shell (MICA-16 step 4).
 *
 * Split from the runtime registry below, and the split is the fix for a real defect: there was
 * one map, so `unregisterApp` deleting from it deleted the only reference to code that is still
 * sitting in the bundle. Uninstalling a core app's dev-only runtime registration and
 * re-registering it then found no component, and the registry's fallback would have handed a
 * "Not part of this build" screen for a component whose code had never left. In CEF the page
 * never unloads, so it stayed wrong for the rest of the session rather than until a refresh.
 *
 * The two maps are genuinely different facts. This one is what the resource contains; the
 * other is what has been installed since boot.
 */
const bundledComponents: Record<string, () => Promise<unknown>> = {};

/**
 * Components that have finished loading — core apps, or a `core: false` fixture
 * `registerApp` accepted under `import.meta.env.DEV` (an add-on proper never has one; see
 * `addOnSources` below).
 *
 * `getComponent` has to answer synchronously — Svelte renders `{#if AppComponent}` and
 * cannot await — so the loader's result is cached here and the render reads the cache.
 * Nothing evicts it: a component is code, the CEF page never unloads, and re-parsing an
 * app the player has already opened once is exactly the cost this change removes.
 */
const loadedComponents: Record<string, AppComponent> = {};

/** Loads in flight, so opening an app twice in quick succession imports it once. */
const loading: Record<string, Promise<AppComponent | undefined>> = {};

/**
 * Registered since boot: a core app's reinstall, or a `core: false` runtime fixture
 * `registerApp` accepted under `import.meta.env.DEV`. Cleared by `unregisterApp`.
 */
const componentRegistry: Record<string, AppComponent> = {};

/**
 * Add-on bundle text — never a component, and never executed by the shell.
 *
 * Holds two different things at different times. For a bundled add-on (`registerAddOn`
 * called with no `source`), it starts empty and `getAddOnSource` fills it lazily, on
 * first open, by fetching `./addons/<id>.js` — the file `pnpm build:addons` produced.
 * For a catalog install (`installVerified`) or a dev-registered one, `registerAddOn`
 * stores the already-fetched, already hash-verified text directly. Either way, this is
 * *source*, handed to the sandboxed iframe transport to run — the shell itself never
 * `import()`s it.
 */
const addOnSources: Record<string, string> = {};

/** Fetches in flight for `getAddOnSource`, mirroring `loading` above. */
const sourceLoads: Record<string, Promise<string | undefined>> = {};

/**
 * A component only ever exists for a core app, or a `core: false` runtime fixture
 * `registerApp` accepted under `import.meta.env.DEV` — never for an add-on proper, which
 * has no component at all (see `getAddOnSource`). Runtime registration wins over the
 * glob's own loader so a dev fixture (or a reinstall) may shadow it; the glob is fallback.
 */
const resolveComponent = (appId: string): AppComponent | undefined =>
  componentRegistry[appId] ?? loadedComponents[appId];

/**
 * Whether an app exists at all, as opposed to whether its code has arrived yet.
 *
 * The two were the same question while every component was loaded at boot, and they are
 * not any more. `openApp` needs this one: refusing an app because its chunk is still in
 * flight would make opening it a race. Extended past components to cover add-ons: a
 * bundled add-on is known (`addOnIds`) whether or not it has been installed yet — the
 * glob is a fact about the build, not the install, same as `bundledComponents` always was
 * for a core app — and an installed remote/dev add-on is known once its source has
 * arrived (`addOnSources`).
 */
const isKnownApp = (appId: string): boolean =>
  Boolean(
    componentRegistry[appId] ||
    bundledComponents[appId] ||
    loadedComponents[appId] ||
    addOnSources[appId] !== undefined ||
    addOnIds.has(appId)
  );

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

/**
 * Fetch a bundled add-on's built bundle text, once — the sandboxed iframe transport runs
 * it, the shell never does.
 *
 * `addOnSources[appId]` already holding a value covers two cases at once: a catalog
 * install or a dev-registered add-on, whose text `registerAddOn` was handed directly and
 * which this never needs to fetch, and a bundled add-on that was opened before and is
 * simply cached. Only a bundled add-on not yet opened reaches the `fetch` below, against
 * `./addons/<id>.js` — the file `pnpm --filter web build:addons` produced (relative:
 * `vite.config.ts` sets `base: './'`). A failed fetch is logged and its promise kept
 * rather than retried on every render, mirroring `loadComponent`.
 */
const getAddOnSource = (appId: string): Promise<string | undefined> => {
  if (addOnSources[appId] !== undefined) return Promise.resolve(addOnSources[appId]);
  if (!addOnIds.has(appId)) return Promise.resolve(undefined);

  sourceLoads[appId] ??= fetch(`./addons/${appId}.js`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const text = await response.text();
      addOnSources[appId] = text;
      return text;
    })
    .catch((error) => {
      console.error(
        `gPhone App Registry: failed to fetch add-on source for '${appId}'`,
        messageOf(error, 'unknown error')
      );
      return undefined;
    });

  return sourceLoads[appId];
};

for (const path in manifestFiles) {
  const rawManifest = (manifestFiles[path] as { default: AppManifest }).default;
  if (rawManifest && rawManifest.id) {
    const manifest = defineApp({
      installedAt: firstBoot,
      updatedAt: firstBoot,
      ...rawManifest
    });
    // Find corresponding component
    const componentPath = path.replace('manifest.ts', 'index.svelte');
    if (import.meta.env.DEV && seenManifestIds.has(manifest.id)) {
      // Two manifest files claiming one id. The second silently replaced the first's
      // component while both stayed listed in the launcher, so one of the two icons opened
      // the other app and nothing said why.
      console.warn(
        `gPhone App Registry: '${manifest.id}' is declared by more than one app in apps/. ` +
          `The last one loaded wins, and ids are also storage namespaces — rename one.`
      );
    }
    seenManifestIds.add(manifest.id);

    // Only a core app's code belongs in `bundledComponents` — an add-on never gets a
    // component loader, bundled or otherwise (MICA-16 step 4): its code runs in a
    // sandboxed iframe from `getAddOnSource`'s fetched text, and the shell must never
    // `import()`/execute it in-process.
    if (manifest.core && appComponents[componentPath]) {
      // The loader, not the component. Called when the app is first opened.
      bundledComponents[manifest.id] = appComponents[componentPath];
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

interface SavedRemoteApp {
  url: string;
  /**
   * The catalog entry `installVerified` built this install's manifest from — the only
   * thing rehydration can rebuild the manifest from, since a saved install carries no
   * component to fall back on and this registry never re-runs fetched code to ask it for
   * one. A row from before this field existed cannot be rehydrated at all. The pinned
   * hash lives on it too (`entry.sha256`) rather than duplicated up here — there is
   * exactly one hash for an install, and keeping only one copy of it is what a stale
   * top-level `sha256` next to a fresher `entry.sha256` cannot silently disagree with.
   */
  entry: CatalogEntry;
}

function getSavedRemoteApps(): SavedRemoteApp[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[])
      .map((row): SavedRemoteApp | null => {
        // Pre-existing installs saved either a bare URL string (an old push-install path,
        // since removed) or `{ url, sha256? }` with no catalog entry at all — neither
        // carries enough to rebuild a manifest without running the bundle to ask it for
        // one, which is exactly what this registry no longer does. Dropped, not silently
        // skipped: the operator/player installed something that is now unrecoverable, and
        // that is worth a line in the console naming what was lost.
        const rowObj =
          row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
        const url =
          typeof row === 'string' ? row : typeof rowObj?.url === 'string' ? rowObj.url : undefined;
        if (!url) return null;

        const entry = rowObj?.entry;
        if (!isCatalogEntry(entry)) {
          console.warn(
            `gPhone Registry: dropped a saved remote app install for '${url}' — it has no ` +
              `catalog entry to rehydrate a manifest from (installed before this build ` +
              `could save one).`
          );
          return null;
        }

        return { url, entry };
      })
      .filter((entry): entry is SavedRemoteApp => entry !== null);
  } catch {
    return [];
  }
}

/**
 * Upsert by `url` **and by app id**. A later install of the same URL always wins: a catalog
 * reinstall with a fresh hash (the operator republished the bundle) replaces a now-stale
 * one — pinned as `entry.sha256`, so a later `saveRemoteApp` call naturally carries the
 * fresh hash along with the rest of the fresh entry. Without this upsert, rehydration would
 * keep re-verifying against whichever entry happened to be saved first, forever.
 *
 * The id half is what makes an *update* (MICA-74) safe. A url-only upsert assumes a
 * republished bundle keeps its URL, and a versioned filename (`weather-2.0.0.js`) does not:
 * the old row survived under its own URL, and the next boot's rehydration installed both,
 * so whichever `Promise.all` resolved last decided which version the player was running.
 * One install, one row.
 */
function saveRemoteApp(entry: SavedRemoteApp) {
  if (typeof localStorage === 'undefined') return;
  try {
    const current = getSavedRemoteApps();
    const withoutExisting = current.filter(
      (e) => e.url !== entry.url && e.entry.id !== entry.entry.id
    );
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify([...withoutExisting, entry]));
  } catch {
    // Ignore localStorage quota/access errors
  }
}

function removeSavedRemoteApp(url: string) {
  if (typeof localStorage === 'undefined') return;
  try {
    const current = getSavedRemoteApps();
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(current.filter((e) => e.url !== url)));
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

/**
 * Refuse to install an add-on this server cannot run.
 *
 * Hiding the icon (`shell/state/appVisibility.ts`) is what a player sees; this is what
 * stops the Store handing them the app in the first place. Installing a money app on a
 * moneyless server is the same broken promise as showing one — it would sit in the
 * Installed list, own a home-grid cell and a storage namespace, and draw nothing.
 *
 * **Only once the server has actually answered.** `capabilitiesKnown` is false until
 * `refreshCapabilities` settles, and both boot paths through here — `rehydrateSavedRemoteApps`
 * and `installedAddOnIds.subscribe` — run at module import, which is strictly before that.
 * Refusing on the starting assumption would turn every saved add-on into a boot-time
 * failure on a perfectly capable server. The visibility filter still hides the icon in that
 * window, so the honest reading is "not yet known" rather than "denied", and the two
 * questions get the answer that is safe for each.
 *
 * A thrown error rather than a quiet skip: `useAppAction`'s `run` in the Store surfaces the
 * message as a toast, and rehydration already logs whatever `installVerified` rejects with.
 * Which is why this one alone among the registry's errors carries no `gPhone App Registry
 * error:` prefix and names the app the way the player sees it — every other error here
 * describes a programming mistake nobody but a developer should ever read, and this one is
 * an ordinary fact about a standalone server.
 */
function assertCapabilitiesAvailable(manifest: AppManifest): void {
  const requires = manifest.requires ?? [];
  if (requires.length === 0 || !get(capabilitiesKnown)) return;

  const available = get(capabilities);
  const missing = requires.filter((name) => available[name] !== true);
  if (missing.length === 0) return;

  throw new Error(
    `${manifest.name} needs ${missing.join(', ')}, which this server does not provide.`
  );
}

// Reactive App Registry Store for Dynamic Community App Installation
function createAppRegistry() {
  const installed = writable<AppManifest[]>(loadedApps);
  const { subscribe, update } = installed;

  /**
   * The bookkeeping every registration path shares — the store update, the installed-
   * add-on tracking, and the home-grid placement — regardless of whether the caller is
   * `registerApp` (a component, core apps and DEV-only fixtures) or `registerAddOn` (a
   * source string, everything else). Split out because that bookkeeping is identical
   * either way; only what gets stashed for later — a component or a source — differs.
   */
  function record(validatedManifest: AppManifest): void {
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
     * default placements at all). This covers what registering an app introduces: a
     * Store install, a catalog install, or (in dev) the harness registering an app the
     * repo does not ship — `error_boundary.spec.ts`'s crashing fixture, which has always
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
  }

  const store = {
    subscribe,
    /**
     * Register a manifest **with its component already loaded** — the in-process path.
     *
     * Stays for core apps, which always ran in-process. For a `core: false` manifest
     * this is **dev-only**: `error_boundary.spec.ts` registers runtime crash fixtures
     * through it, and nothing shipped is meant to reach it — a real add-on registers
     * through `registerAddOn` below, as source text, and runs sandboxed. Blocked outside
     * `import.meta.env.DEV` so a production build can't be handed a live component for
     * an app that never went through the sandboxed transport.
     */
    registerApp: (manifest: AppManifest, component: AppComponent) => {
      const validatedManifest = defineApp(manifest);
      if (!validatedManifest.core && !import.meta.env.DEV) {
        throw new Error(
          'gPhone App Registry error: add-ons register through registerAddOn(manifest, source).'
        );
      }
      componentRegistry[validatedManifest.id] = component;
      record(validatedManifest);
    },
    /**
     * Register a manifest with its bundle **as source text**, never executed here.
     *
     * `source` given explicitly — a catalog install (`installVerified`, already
     * hash-verified) or a dev-registered add-on — is stashed as-is. Omitted, `manifest.id`
     * must be one of this build's own bundled add-ons (`addOnIds`); its text is left for
     * `getAddOnSource` to fetch lazily, on first open, rather than eagerly here.
     */
    registerAddOn: (manifest: AppManifest, source?: string) => {
      const validatedManifest = defineApp(manifest);
      assertCapabilitiesAvailable(validatedManifest);
      if (source !== undefined) {
        addOnSources[validatedManifest.id] = source;
      } else if (!addOnIds.has(validatedManifest.id)) {
        throw new Error(
          `gPhone App Registry error: '${validatedManifest.id}' was registered with no ` +
            `source and is not one of this build's bundled add-ons — there is nothing for ` +
            `getAddOnSource to fetch.`
        );
      }
      record(validatedManifest);
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
        removeSavedRemoteApp(targetApp.bundleUrl);
      } else {
        installedAddOnIds.update((ids) => ids.filter((id) => id !== appId));
      }
      /**
       * The runtime map only. A core app's own component stays where the glob put it
       * (`bundledComponents`, never deleted), because uninstalling an app does not remove
       * its code from the resource — deleting it there is what used to make a reinstall
       * mount the "not part of this build" placeholder. This only ever clears a runtime
       * registration: a reinstalled core app, or a dev-only `core: false` fixture.
       */
      delete componentRegistry[appId];
      // The source text, and the fetch that produced it. Unlike `bundledComponents` (never
      // deleted — the glob's loader is a fact about the build, not the install), a bundled
      // add-on's fetched text is treated the same as a remote/dev one's here: gone on
      // uninstall, and lazily re-fetched by `getAddOnSource` on the next install/open.
      delete addOnSources[appId];
      delete sourceLoads[appId];
      clearAppStorage(appId);
      update((apps) => apps.filter((a) => a.id !== appId));
    },
    getComponent: (appId: string): AppComponent | undefined => resolveComponent(appId),
    /** Whether the app exists, regardless of whether its chunk has arrived. */
    isKnownApp,
    /** Fetch an app's component. Idempotent, and the only thing that imports app code. */
    loadComponent,
    /**
     * Fetch an add-on's bundle *text*, never its component — the sandboxed iframe
     * transport runs it, this registry only ever hands over bytes. Idempotent, same as
     * `loadComponent`.
     */
    getAddOnSource,
    /**
     * Whether the app has actually been installed — the question `getManifest` used to be
     * asked in place of, and stopped being able to answer.
     *
     * `getManifest` resolves a bundled add-on that has never been installed (see its own
     * comment), which is right for rendering one opened by a deep link and wrong for any
     * gate that means "the player has this app". `nuiMessages`' `appEvent` is exactly such a
     * gate: it reads the manifest's `permissions` to decide whether a pushed toast is
     * allowed, and with the fallback in place a never-installed Blabber would have started
     * raising toasts. Installed-ness is its own fact, so it gets its own question.
     */
    isInstalled: (appId: string): boolean =>
      get(installed).some((a: AppManifest) => a.id === appId),
    /**
     * The manifest for an app the shell can render — installed, or a bundled add-on.
     *
     * The shell holds app *ids*; anything shown to a player needs the manifest's `name`.
     * Without this the error boundary rendered the id rather than the manifest's
     * `name`, which are not the same string.
     *
     * The `addOns` fallback exists because `installed` and *renderable* are not the same
     * set for a `core: false` app. `isKnownApp` already counts a bundled add-on as known
     * whether or not it has been installed, so `openApp('notes')` from a `?app=` deep
     * link legitimately makes it the current app — but `Shell.svelte` renders through
     * `{#if manifest && ...}`, so an installed-only lookup left that path on a permanent
     * spinner. Opening an uninstalled add-on straight from a deep link is by design (it
     * is how the dev harness reaches one), so the manifest has to resolve for it. It is
     * still a fact about the build, not the install: `addOns` is written once at startup
     * from the manifest glob and nothing that is not in this bundle can appear in it.
     */
    getManifest: (appId: string): AppManifest | undefined =>
      get(installed).find((a: AppManifest) => a.id === appId) ??
      addOns.find((a: AppManifest) => a.id === appId),
    /**
     * The only way a remote app is ever installed. Builds the manifest from `entry` —
     * never from anything the fetched bundle itself claims to be — after the bundle's
     * bytes are hash-verified against `entry.sha256`. See `installVerified` below.
     */
    installFromCatalog: (entry: CatalogEntry): Promise<{ manifest: AppManifest }> =>
      installVerified(entry),
    rehydrateSavedRemoteApps: async (): Promise<void> => {
      // Nothing can clear the host check while the allowlist is empty, so with no allowlist
      // this is not "every saved install failed", it is "the operator's configuration has
      // not arrived yet". It arrives over NUI (`state/remoteAppConfig.ts`, MICA-126),
      // strictly after this module is first imported, and that module calls this again once
      // it has applied it. Returning quietly rather than warning per app is the difference
      // between a boot log that names a real problem and one that cries wolf on every start.
      if (getTrustedRemoteAppHosts().length === 0) return;

      const savedRemoteApps = getSavedRemoteApps();
      await Promise.all(
        savedRemoteApps.map((saved) =>
          // A pinned hash re-verifies on every boot, not only at install time — a bundle
          // swapped out after install must be refused, not silently re-run.
          installVerified(saved.entry).catch((err) => {
            console.warn(
              `gPhone Registry failed to re-hydrate remote app from '${saved.url}':`,
              err
            );
          })
        )
      );
    }
  };

  /**
   * Fetch, hash-verify, and register a catalog entry's bundle — the one path both
   * `installFromCatalog` and boot rehydration use. The manifest comes from `entry` alone;
   * nothing here ever `import()`s the fetched bytes to ask the module what it claims to
   * be, which is the whole point of the catalog carrying a manifest in the first place.
   */
  async function installVerified(entry: CatalogEntry): Promise<{ manifest: AppManifest }> {
    // `isTrustedRemoteUrl` exempts `data:` URLs — safe for its other callers, which only
    // ever build one internally from bytes already hash-verified, never from anything an
    // operator's catalog (or a saved/rehydrated row derived from one) supplied. A catalog
    // entry is exactly the kind of external input that exemption assumes never reaches
    // it, so it is rejected here explicitly, before the host check and before any fetch —
    // the same boundary `nuiMessages.ts`'s `installApp` applies to an NUI payload.
    if (entry.bundleUrl.startsWith('data:')) {
      throw new Error(
        `gPhone App Loader error: '${entry.bundleUrl}' is a data: URL, which a catalog entry ` +
          'may not use.'
      );
    }
    if (!isTrustedRemoteUrl(entry.bundleUrl)) {
      throw new Error(
        `gPhone App Loader error: '${entry.bundleUrl}' is not on the trusted remote-app host allowlist.`
      );
    }

    const response = await fetch(entry.bundleUrl);
    if (!response.ok) {
      throw new Error(
        `gPhone App Loader error: HTTP ${response.status} fetching '${entry.bundleUrl}'.`
      );
    }
    const code = await response.text();

    const verified = await matchesHash(code, entry.sha256);
    if (!verified) {
      throw new Error(
        `gPhone App Loader error: '${entry.bundleUrl}' did not match its published checksum. ` +
          'Refusing to run it.'
      );
    }

    const validatedManifest = defineApp({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      color: entry.color,
      icon: entry.icon ?? null,
      permissions: entry.permissions,
      // The manifest is built from `entry` and nothing else, so a capability the catalog
      // does not carry is one the installed app can never declare — it would install
      // ungated on a server that cannot run it. `isCatalogEntry` has already refused any
      // row naming a capability `ALL_CAPABILITIES` does not know.
      ...(entry.requires ? { requires: entry.requires } : {}),
      requiresNetwork: entry.requiresNetwork ?? false,
      networkHosts: entry.networkHosts ?? [],
      isRemote: true,
      bundleUrl: entry.bundleUrl,
      core: false
    });

    store.registerAddOn(validatedManifest, code);
    saveRemoteApp({ url: entry.bundleUrl, entry });

    return { manifest: validatedManifest };
  }

  // Rehydrate saved remote apps on startup if running in browser/client environment
  if (typeof window !== 'undefined') {
    void store.rehydrateSavedRemoteApps();

    /**
     * Re-register every previously installed bundled add-on.
     *
     * `subscribe` rather than a one-shot loop like the remote-URL rehydration above:
     * unlike that raw-localStorage read, `installedAddOnIds` is a live `usePersisted`
     * store, so one subscription covers both boot (fires immediately with the current
     * value) and a later character switch (`usePersisted`'s own rehydrate-on-server-copy
     * pushes a new value, which re-fires this subscription).
     *
     * No component to await here any more: `registerAddOn` with no `source` registers
     * immediately and leaves the fetch to `getAddOnSource`, lazily, on first open.
     */
    installedAddOnIds.subscribe((ids) => {
      for (const id of ids) {
        if (get(installed).some((a) => a.id === id)) continue;
        const manifest = addOns.find((a) => a.id === id);
        if (!manifest) continue; // no longer part of this build
        store.registerAddOn(manifest);
      }
    });
  }

  return store;
}

export const appRegistryStore = createAppRegistry();
