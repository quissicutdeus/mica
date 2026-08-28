<script lang="ts">
  import { fade } from '../lib/motion';
  import { get } from 'svelte/store';
  import { registerHandler } from './state/keybinds';
  import { attachLongPressDrag } from '../lib/longPressDrag';
  import { focusTrap } from '../lib/focusTrap';
  import AppIcon from '../sdk/ui/AppIcon.svelte';
  import { appRegistryStore } from './state/registry';
  import { isAdmin } from '../services/admin';
  import { homeGridItems, openFolderId, renameFolder, type HomeGridFolder } from './state/homeGrid';
  import {
    iconDragState,
    resolveDropAtPoint,
    resolveIconDrop,
    startIconDrag,
    moveIconDrag
  } from './state/iconDrag';

  let { openApp } = $props<{ openApp: (id: string) => void }>();

  let folder = $derived(
    $homeGridItems.find(
      (item): item is HomeGridFolder => item.kind === 'folder' && item.folderId === $openFolderId
    ) ?? null
  );

  let visibleApps = $derived(
    (folder?.appIds ?? [])
      .map((id) => appRegistryStore.getManifest(id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m) && (!m!.requiresAdmin || get(isAdmin)))
  );

  function close(): void {
    openFolderId.set(null);
  }

  let dialogRef = $state<HTMLElement | null>(null);

  /** Announce the folder on open, and start Tab inside it — see `sdk/ui/ConfirmDialog`. */
  $effect(() => {
    if ($openFolderId) dialogRef?.focus({ preventScroll: true });
  });

  let unregisterBack: (() => void) | null = null;
  $effect(() => {
    if ($openFolderId) {
      if (!unregisterBack) unregisterBack = registerHandler('back', close);
    } else if (unregisterBack) {
      unregisterBack();
      unregisterBack = null;
    }
  });

  function attachIcon(node: HTMLElement, appId: string) {
    const detach = attachLongPressDrag(node, {
      onLongPress: (e) => {
        if (!folder) return;
        const manifest = appRegistryStore.getManifest(appId) ?? null;
        const folderId = folder.folderId;
        close();
        startIconDrag(appId, { kind: 'folder', folderId }, e.clientX, e.clientY, manifest);
      },
      onDragMove: (x, y) => moveIconDrag(x, y),
      onDragEnd: (x, y) => {
        resolveIconDrop(get(iconDragState), resolveDropAtPoint(x, y));
      },
      onDragCancel: () => {}
    });
    return { destroy: detach };
  }
</script>

{#if folder}
  <div
    transition:fade={{ duration: 150 }}
    class="bg-scrim absolute inset-0 z-56 flex items-center justify-center p-8 backdrop-blur-sm"
    onclick={(e) => {
      // Only a click on the scrim itself closes. This used to be `onclick={close}` here
      // and a `stopPropagation` handler on the card, which cost the card a
      // `role="presentation"` it now needs for `role="dialog"` instead.
      if (e.target === e.currentTarget) close();
    }}
    role="presentation"
  >
    <!-- Modal, like the drawer and the shade: the home screen's icons are still behind it
         and still in the tab order. See `lib/focusTrap.ts`. -->
    <div
      bind:this={dialogRef}
      use:focusTrap
      role="dialog"
      aria-modal="true"
      aria-label={folder.name || 'Folder'}
      tabindex="-1"
      class="bg-surface-container shadow-elevation-5 w-full rounded-xl p-5 outline-none"
    >
      <input
        type="text"
        placeholder="Unnamed"
        value={folder.name}
        onblur={(e) => folder && renameFolder(folder.folderId, e.currentTarget.value)}
        class="text-on-surface placeholder:text-on-surface-variant text-title-medium mb-4 w-full bg-transparent text-center outline-none"
      />

      <div class="grid grid-cols-4 gap-y-5">
        {#each visibleApps as app (app.id)}
          <div use:attachIcon={app.id}>
            <AppIcon
              name={app.name}
              color={app.color}
              icon={app.icon}
              badgeStore={app.badgeStore}
              onclick={() => {
                close();
                openApp(app.id);
              }}
            />
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
