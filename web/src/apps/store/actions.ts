// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useAppAction,
  useAppRegistryWrite,
  type AppManifest,
  type AppPermission,
  type AppUpdate,
  type Translate
} from '@mica/sdk';
import { addedPermissions } from './appInfo';

/** An update waiting on the player to accept the permissions it adds (MICA-196). */
export interface PendingConsent {
  update: AppUpdate;
  added: AppPermission[];
}

export interface StoreActionDeps {
  /** The live translator, read per call so a language change mid-session is followed. */
  t: () => Translate;
  run: ReturnType<typeof useAppAction>['run'];
  registry: ReturnType<typeof useAppRegistryWrite>;
  /** The pending update for an app, if the catalog has moved past what is installed. */
  updateFor: (appId: string) => AppUpdate | null;
  /** Why an app cannot be installed here, or `null` — `appInfo.ts`'s reasons. */
  unavailableFor: (app: AppManifest) => string | null;
  /** Show the more-access dialog for an update; `confirmUpdate` is its yes. */
  askConsent: (pending: PendingConsent) => void;
  /** An app was uninstalled, so a screen showing it can let go. */
  onUninstalled: (app: AppManifest) => void;
}

/**
 * What the Store does — install, update, uninstall — once, for both of its roots.
 *
 * Pulled out of `index.svelte` when MICA-264 put the Store on the tablet: `tablet.svelte` is a
 * second layout of the same app, and two copies of the install path is two places for the
 * consent record or the update check to drift apart. The screens keep their own state (which
 * tab, which app is selected, which dialog is open) and hand this the few callbacks it needs.
 */
export function createStoreActions(deps: StoreActionDeps) {
  const { run, registry } = deps;

  function install(app: AppManifest) {
    const t = deps.t();
    if (deps.unavailableFor(app)) return;
    if (app.isRemote && app.bundleUrl) {
      const target = app;
      void run(
        async () => {
          const catalog = await registry.fetchRemoteCatalog();
          if (catalog.status === 'off') throw new Error(t('store.noCatalog'));
          if (catalog.status === 'unavailable') throw new Error(t('store.catalogUnavailable'));
          const entry = catalog.entries.find((e) => e.id === target.id);
          if (!entry) throw new Error(t('store.notInCatalog', { name: target.name }));
          await registry.installFromCatalog(entry);
          // MICA-201: the player tapped Install on a screen listing exactly this set, so
          // this is their answer and the shell now holds it. Without it the install lands
          // and the add-on reaches nothing — the host refuses any permission with no grant.
          registry.recordConsent(entry.id, entry.permissions ?? []);
        },
        {
          title: t('store.title'),
          success: t('store.installedToast', { name: app.name })
        }
      );
      return;
    }

    // No component to load: a bundled add-on registers as source text, fetched lazily by
    // `getAddOnSource` the first time it is opened, not eagerly here — the shell never
    // `import()`s an add-on's code in-process (MICA-16 step 4).
    void run(
      () => {
        registry.registerAddOn(app);
        registry.recordConsent(app.id, app.permissions ?? []);
      },
      {
        title: t('store.title'),
        success: t('store.installedToast', { name: app.name })
      }
    );
  }

  function applyUpdate(name: string, pending: AppUpdate) {
    const t = deps.t();
    void run(
      async () => {
        const manifest = await registry.updateApp(pending.appId);
        // The answer, recorded after the update actually lands: the new bundle's set
        // replaces the old grant, so an update that *drops* a permission narrows it too.
        registry.recordConsent(pending.appId, pending.entry.permissions ?? []);
        return manifest;
      },
      {
        title: t('store.title'),
        success: t('store.updatedToast', { name, version: pending.availableVersion })
      }
    );
  }

  /**
   * Install the catalog's copy of an app that has fallen behind.
   *
   * One install path, still: `updateApp` goes through `installFromCatalog`, so the bundle
   * is re-fetched and re-verified against the entry's `sha256` exactly as it was the first
   * time. What is new is that the *permissions* are compared against what the player
   * accepted, because a catalog entry is remote data that moves underneath an installed
   * app — an add-on installed reading nothing can republish asking for `contacts` and
   * `messages`, and the old path installed that in one tap. The comment this replaces said
   * the accepted permissions "are on screen while they tap this"; they are on screen in
   * `AppDetails`, which lists the *installed* app's, not the ones the new version wants.
   *
   * An update that adds nothing still installs with no dialog. Prompting on every update
   * would train the answer, which is how a prompt stops being consent.
   *
   * Refusing is refusing the permissions, not merely the dialog: since MICA-201 the
   * shell keeps its own record of what the player granted each add-on and re-checks every
   * call against it as well as against the manifest, so a permission nobody accepted here
   * is refused at the host even if a bundle declaring it is somehow installed.
   */
  function update(app: AppManifest) {
    const pending = deps.updateFor(app.id);
    if (!pending) return;
    // Against the **grant**, not the installed manifest (MICA-201). The manifest is what
    // the bundle asked for; the grant is what the player answered, and it is the only one
    // of the two that this app could not have written itself.
    const added = addedPermissions(registry.grantedPermissions(app.id), pending.entry);
    if (added.length > 0) {
      deps.askConsent({ update: pending, added });
      return;
    }
    applyUpdate(pending.name, pending);
  }

  /** The more-access dialog's yes. */
  function confirmUpdate(pending: PendingConsent) {
    applyUpdate(pending.update.name, pending.update);
  }

  async function uninstall(app: AppManifest) {
    const t = deps.t();
    const removed = await run(() => registry.unregisterApp(app.id), {
      title: t('store.title'),
      success: t('store.uninstalledToast', { name: app.name })
    });
    if (removed) deps.onUninstalled(app);
  }

  return { install, update, confirmUpdate, uninstall };
}

/** The Installed tab's filter and order, shared by both roots. */
export type InstalledFilter = 'all' | 'system' | 'addon';
export type InstalledSortOrder = 'newest' | 'oldest' | 'updated' | 'name';

export function filterInstalled(
  apps: readonly AppManifest[],
  filter: InstalledFilter,
  sortOrder: InstalledSortOrder
): AppManifest[] {
  return apps
    .filter((app) => {
      if (filter === 'system') return app.core;
      if (filter === 'addon') return !app.core;
      return true;
    })
    .slice()
    .sort((a, b) => {
      if (sortOrder === 'name') return a.name.localeCompare(b.name);

      const installedA = a.installedAt ? new Date(a.installedAt).getTime() : 0;
      const installedB = b.installedAt ? new Date(b.installedAt).getTime() : 0;
      const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;

      if (sortOrder === 'oldest') {
        return installedA - installedB || a.name.localeCompare(b.name);
      }
      if (sortOrder === 'updated') {
        return updatedB - updatedA || a.name.localeCompare(b.name);
      }
      return installedB - installedA || a.name.localeCompare(b.name);
    });
}
