<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    useAppRegistry,
    useAppRegistryWrite,
    useNavigation,
    type AppManifest,
    ConfirmDialog,
    Screen,
    SegmentedControl,
    useAppAction,
    type AppProps,
    type AppUpdate,
    fetchCatalog,
    getRemoteCatalogUrl,
    onAppForeground,
    useLocale,
    registerMessages,
    type AppPermission
  } from '@gos/sdk';
  import { addedPermissions, formatPermission, mergedCatalogApps } from './appInfo';
  import AppDetails from './components/AppDetails.svelte';
  import CatalogList from './components/CatalogList.svelte';
  import InstalledList from './components/InstalledList.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // MICA-215: registered here, at the app's entry point, so every screen in the Store —
  // the two lists and the details page — reads out of one catalog under `store.`.
  registerMessages('store', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  // Starts empty; `mergedCatalogApps` (bundled add-ons + whatever the configured catalog
  // returns) fills it in once the fetch below resolves. `catalogApps()` is not called
  // directly here any more — `mergedCatalogApps` already calls it internally.
  let catalogAppsList = $state<AppManifest[]>([]);

  const { registryStore, updatesStore } = useAppRegistry();
  const {
    unregisterApp,
    registerAddOn,
    installFromCatalog,
    refreshUpdates,
    updateApp,
    recordConsent,
    grantedPermissions
  } = useAppRegistryWrite();

  const { openApp: openPhoneApp } = useNavigation();
  const { run } = useAppAction('store');

  /**
   * `onAppForeground`, not `$effect`/`onMount` (§11): apps are resident, so a fetch that ran
   * once per session would show whichever catalog was live the first time the Store was
   * opened for the rest of the phone's life — and the whole point of the update check is
   * that the catalog moves underneath you. Re-asked on every visit.
   */
  onAppForeground('store', () => {
    void mergedCatalogApps(getRemoteCatalogUrl()).then((apps) => (catalogAppsList = apps));
    void refreshUpdates();
  });

  let activeTab = $state<'catalog' | 'installed'>('catalog');
  let installedFilter = $state<'all' | 'system' | 'addon'>('all');
  let installedSortOrder = $state<'newest' | 'oldest' | 'updated' | 'name'>('newest');
  let selectedApp = $state<AppManifest | null>(null);
  let appToUninstall = $state<AppManifest | null>(null);
  /**
   * An update whose catalog entry asks for more than the installed app was granted
   * (MICA-196). Held until the player says yes, because tapping Update on a row that
   * shows a version number is not consent to a list they have not been shown.
   */
  let updateToAccept = $state<{ update: AppUpdate; added: AppPermission[] } | null>(null);

  const isInstalled = (appId: string): boolean => $registryStore.some((a) => a.id === appId);

  /** The pending update for an app, if the catalog has moved past what is installed. */
  const updateFor = (appId: string): AppUpdate | null =>
    $updatesStore.find((u) => u.appId === appId) ?? null;

  const filteredInstalledApps = $derived(
    $registryStore
      .filter((app) => {
        if (installedFilter === 'system') return app.core;
        if (installedFilter === 'addon') return !app.core;
        return true;
      })
      .slice()
      .sort((a, b) => {
        if (installedSortOrder === 'name') return a.name.localeCompare(b.name);

        const installedA = a.installedAt ? new Date(a.installedAt).getTime() : 0;
        const installedB = b.installedAt ? new Date(b.installedAt).getTime() : 0;
        const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;

        if (installedSortOrder === 'oldest') {
          return installedA - installedB || a.name.localeCompare(b.name);
        }
        if (installedSortOrder === 'updated') {
          return updatedB - updatedA || a.name.localeCompare(b.name);
        }
        return installedB - installedA || a.name.localeCompare(b.name);
      })
  );

  function handleInstall(app: AppManifest) {
    if (app.isRemote && app.bundleUrl) {
      const target = app;
      void run(
        async () => {
          const catalogUrl = getRemoteCatalogUrl();
          if (!catalogUrl) throw new Error($t('store.noCatalog'));
          const entries = await fetchCatalog(catalogUrl);
          const entry = entries.find((e) => e.id === target.id);
          if (!entry) throw new Error($t('store.notInCatalog', { name: target.name }));
          await installFromCatalog(entry);
          // MICA-201: the player tapped Install on a screen listing exactly this set, so
          // this is their answer and the shell now holds it. Without it the install lands
          // and the add-on reaches nothing — the host refuses any permission with no grant.
          recordConsent(entry.id, entry.permissions ?? []);
        },
        {
          title: $t('store.title'),
          success: $t('store.installedToast', { name: app.name })
        }
      );
      return;
    }

    // No component to load: a bundled add-on registers as source text, fetched lazily by
    // `getAddOnSource` the first time it is opened, not eagerly here — the shell never
    // `import()`s an add-on's code in-process (MICA-16 step 4).
    void run(
      () => {
        registerAddOn(app);
        recordConsent(app.id, app.permissions ?? []);
      },
      {
        title: $t('store.title'),
        success: $t('store.installedToast', { name: app.name })
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
  function handleUpdate(app: AppManifest) {
    const pending = updateFor(app.id);
    if (!pending) return;
    // Against the **grant**, not the installed manifest (MICA-201). The manifest is what
    // the bundle asked for; the grant is what the player answered, and it is the only one
    // of the two that this app could not have written itself.
    const added = addedPermissions(grantedPermissions(app.id), pending.entry);
    if (added.length > 0) {
      updateToAccept = { update: pending, added };
      return;
    }
    applyUpdate(pending.name, pending);
  }

  function applyUpdate(name: string, pending: AppUpdate) {
    void run(
      async () => {
        const manifest = await updateApp(pending.appId);
        // The answer, recorded after the update actually lands: the new bundle's set
        // replaces the old grant, so an update that *drops* a permission narrows it too.
        recordConsent(pending.appId, pending.entry.permissions ?? []);
        return manifest;
      },
      {
        title: $t('store.title'),
        success: $t('store.updatedToast', { name, version: pending.availableVersion })
      }
    );
  }

  function confirmPermissionUpdate() {
    const pending = updateToAccept;
    updateToAccept = null;
    if (!pending) return;
    applyUpdate(pending.update.name, pending.update);
  }

  const requestUninstall = (app: AppManifest) => (appToUninstall = app);

  async function handleUninstall(app: AppManifest) {
    const removed = await run(() => unregisterApp(app.id), {
      title: $t('store.title'),
      success: $t('store.uninstalledToast', { name: app.name })
    });
    if (removed && selectedApp?.id === app.id) selectedApp = null;
  }

  function confirmUninstall() {
    if (!appToUninstall) return;
    const target = appToUninstall;
    appToUninstall = null;
    void handleUninstall(target);
  }
</script>

<div
  class="bg-surface text-on-secondary selection:bg-secondary selection:text-on-secondary relative flex h-full w-full flex-col overflow-hidden"
>
  {#if selectedApp}
    <AppDetails
      app={selectedApp}
      installed={isInstalled(selectedApp.id)}
      update={updateFor(selectedApp.id)}
      onback={() => (selectedApp = null)}
      oninstall={handleInstall}
      onupdate={handleUpdate}
      onuninstall={requestUninstall}
      onopen={openPhoneApp}
    />
  {:else}
    <Screen title={$t('store.title')} {onback}>
      <div class="space-y-4 p-4">
        <!--
          Shown on both tabs, because a player who opened the Store from the launcher badge
          has no idea which tab the news is on. Tapping it goes where the buttons are.
        -->
        {#if $updatesStore.length > 0}
          <button
            onclick={() => {
              activeTab = 'installed';
              installedFilter = 'addon';
            }}
            class="bg-primary-container text-on-primary-container text-body-small duration-short ease-standard flex w-full items-center justify-between gap-2 rounded-box px-3 py-2 text-left transition active:scale-95"
          >
            <span>
              {$t(
                $updatesStore.length === 1
                  ? 'store.updatesAvailableOne'
                  : 'store.updatesAvailableOther',
                { count: $updatesStore.length }
              )}
            </span>
            <span aria-hidden="true">›</span>
          </button>
        {/if}

        <SegmentedControl
          aria-label={$t('store.sections')}
          selected={activeTab}
          onchange={(id) => (activeTab = id as 'catalog' | 'installed')}
          options={[
            { id: 'catalog', label: $t('store.tabCatalog') },
            { id: 'installed', label: $t('store.tabInstalled', { count: $registryStore.length }) }
          ]}
        />

        {#if activeTab === 'catalog'}
          <CatalogList
            apps={catalogAppsList}
            {isInstalled}
            onselect={(app: AppManifest) => (selectedApp = app)}
            oninstall={handleInstall}
            onuninstall={requestUninstall}
          />
        {:else}
          <InstalledList
            apps={filteredInstalledApps}
            updates={$updatesStore}
            bind:filter={installedFilter}
            bind:sortOrder={installedSortOrder}
            onselect={(app: AppManifest) => (selectedApp = app)}
            onopen={openPhoneApp}
            onupdate={handleUpdate}
          />
        {/if}
      </div>
    </Screen>
  {/if}

  <!-- MICA-196: an update asking for more than the installed version was granted -->
  {#if updateToAccept}
    {@const added = updateToAccept.added.map((p) => formatPermission(p, $t).label).join(', ')}
    <ConfirmDialog
      title={$t('store.moreAccessTitle', { name: updateToAccept.update.name })}
      message={$t('store.moreAccessMessage', {
        version: updateToAccept.update.availableVersion,
        added
      })}
      confirmText={$t('store.updateAnyway')}
      cancelText={$t('store.keepThisVersion')}
      onconfirm={confirmPermissionUpdate}
      oncancel={() => (updateToAccept = null)}
    />
  {/if}

  <!-- Confirm Uninstall Modal -->
  {#if appToUninstall}
    <ConfirmDialog
      title={$t('store.uninstallTitle', { name: appToUninstall.name })}
      message={$t('store.uninstallMessage', { name: appToUninstall.name })}
      confirmText={$t('store.uninstall')}
      cancelText={$t('store.cancel')}
      confirmVariant="danger"
      onconfirm={confirmUninstall}
      oncancel={() => (appToUninstall = null)}
    />
  {/if}
</div>
