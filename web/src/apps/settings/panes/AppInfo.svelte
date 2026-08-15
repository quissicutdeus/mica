<script lang="ts">
  import {
    appStorageBytes,
    clearAppStorage,
    Button,
    ConfirmDialog,
    formatDate,
    useAppAction,
    useAppRegistry,
    type AppManifest
  } from '@gphone/sdk';

  /**
   * One app, and the two things a player can do to it.
   *
   * **Clear storage** returns it to a freshly installed state without removing it. **Uninstall**
   * runs the registry's own `unregisterApp`, which is what the Store calls — so there is one
   * removal path rather than two that can disagree about what gets cleaned up. It sweeps the
   * app's storage, forgets a remote bundle's saved URL, and drops the app from the launcher.
   *
   * Uninstall is absent for a system app rather than present and failing. `unregisterApp` throws
   * for a core id, and the Store has already shipped the other version of this: it derived
   * "system" separately from the registry, the two answers differed, and it rendered a button
   * that could only error. `manifest.core` is the one answer.
   */
  let {
    app,
    onremoved
  }: {
    app: AppManifest;
    onremoved: () => void;
  } = $props();

  const { unregisterApp } = useAppRegistry();
  const { run, busy } = useAppAction('settings');

  let confirming = $state<'clear' | 'uninstall' | null>(null);

  /**
   * Storage is read on demand, not subscribed — there is no store behind localStorage. So a
   * clear has to nudge the read: `app` has not changed, and the byte count has.
   */
  let storageVersion = $state(0);
  const bytes = $derived.by(() => {
    void storageVersion;
    return appStorageBytes(app.id);
  });
  const storageLabel = $derived(
    bytes === 0 ? 'Nothing stored' : bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
  );

  const clear = async (): Promise<void> => {
    confirming = null;
    if (
      await run(() => clearAppStorage(app.id), {
        title: app.name,
        success: 'Storage cleared'
      })
    ) {
      storageVersion += 1;
    }
  };

  const uninstall = async (): Promise<void> => {
    confirming = null;
    // `run` reports the failure for us — `unregisterApp` throws for a core app, and this button
    // is not rendered for one, so a throw here means something the player should be told about.
    if (await run(() => unregisterApp(app.id), { title: app.name, success: 'Uninstalled' })) {
      onremoved();
    }
  };
</script>

<div class="space-y-6 p-4">
  <div class="flex items-center gap-3">
    <div
      class="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg {app.color} shadow-lg"
    >
      {#if typeof app.icon === 'string' && app.icon.startsWith('http')}
        <img src={app.icon} alt="" class="h-7 w-7 object-contain invert filter" />
      {:else if typeof app.icon === 'function'}
        {@const IconComp = app.icon}
        <IconComp />
      {:else}
        <span class="text-on-surface text-lg font-bold">{app.name.charAt(0)}</span>
      {/if}
    </div>
    <div class="min-w-0">
      <p class="text-on-surface truncate text-base font-semibold">{app.name}</p>
      <p class="text-on-surface-variant truncate text-xs">
        {app.core ? 'System app' : 'Store add-on'}{app.isRemote ? ' · remote' : ''}
      </p>
      {#if app.description}
        <p class="text-on-surface mt-1 text-xs">{app.description}</p>
      {/if}
    </div>
  </div>

  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Details
    </h2>
    <div
      class="divide-outline-variant bg-surface-container divide-y overflow-hidden rounded-xl text-sm"
    >
      <div class="flex items-center justify-between p-4">
        <span class="text-on-surface-variant">Identifier</span>
        <span class="text-on-surface font-mono text-xs">{app.id}</span>
      </div>
      <div class="flex items-center justify-between p-4">
        <span class="text-on-surface-variant">Author</span>
        <span class="text-on-surface">{app.author || 'gPhone'}</span>
      </div>
      {#if app.version}
        <div class="flex items-center justify-between p-4">
          <span class="text-on-surface-variant">Version</span>
          <span class="text-on-surface">{app.version}</span>
        </div>
      {/if}
      {#if app.installedAt}
        <div class="flex items-center justify-between p-4">
          <span class="text-on-surface-variant">Installed</span>
          <span class="text-on-surface">{formatDate(app.installedAt)}</span>
        </div>
      {/if}
      <div class="flex items-center justify-between p-4">
        <span class="text-on-surface-variant">Storage used</span>
        <span class="text-on-surface">{storageLabel}</span>
      </div>
    </div>
  </div>

  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Manage
    </h2>
    <div class="space-y-2">
      <Button
        variant="secondary"
        class="w-full"
        disabled={$busy || bytes === 0}
        onclick={() => (confirming = 'clear')}
      >
        Clear storage
      </Button>
      <p class="text-on-surface-variant px-2 text-xs">
        {bytes === 0
          ? 'Nothing to clear — this app has stored nothing yet.'
          : 'Returns the app to a freshly installed state. The app stays installed.'}
      </p>

      {#if app.core}
        <p class="text-on-surface-variant px-2 pt-2 text-xs">
          System apps ship with the phone and cannot be uninstalled.
        </p>
      {:else}
        <Button
          variant="danger"
          class="mt-2 w-full"
          disabled={$busy}
          onclick={() => (confirming = 'uninstall')}
        >
          Uninstall
        </Button>
        <p class="text-on-surface-variant px-2 text-xs">
          Removes the app and everything it stored. It can be installed again from the Store.
        </p>
      {/if}
    </div>
  </div>
</div>

{#if confirming === 'clear'}
  <ConfirmDialog
    title="Clear {app.name} data?"
    message="Everything {app.name} has stored on this phone is deleted and the app returns to a freshly installed state. The app itself stays installed."
    confirmText="Clear"
    onconfirm={clear}
    oncancel={() => (confirming = null)}
  />
{:else if confirming === 'uninstall'}
  <ConfirmDialog
    title="Uninstall {app.name}?"
    message="{app.name} is removed from the phone along with everything it stored. You can install it again from the Store."
    confirmText="Uninstall"
    onconfirm={uninstall}
    oncancel={() => (confirming = null)}
  />
{/if}
