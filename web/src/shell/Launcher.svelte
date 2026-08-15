<script lang="ts">
  import { get } from 'svelte/store';
  import { isAdmin } from '../services/admin';
  import AppIcon from '../sdk/ui/AppIcon.svelte';
  import { attachLongPressDrag } from '../lib/longPressDrag';
  import { appRegistryStore } from './state/registry';
  import { homeGridColumns, homeGridRows } from './state/homeGridSettings';
  import { homeGridItems, openFolderId, type HomeGridItem } from './state/homeGrid';
  import {
    iconDragState,
    resolveDropAtPoint,
    resolveIconDrop,
    startIconDrag,
    moveIconDrag
  } from './state/iconDrag';
  import FolderPopup from './FolderPopup.svelte';

  let { openApp } = $props<{ openApp: (id: string) => void }>();

  interface Cell {
    position: number;
    item: HomeGridItem | null;
  }

  /**
   * Row-major: `position` 0 is top-left, increasing left-to-right then top-to-bottom —
   * matching a plain CSS grid's default auto-placement, so no explicit row/column math is
   * needed beyond `grid-template-columns`.
   */
  let cells = $derived.by((): Cell[] => {
    const capacity = $homeGridColumns * $homeGridRows;
    const byPosition = new Map($homeGridItems.map((item) => [item.position, item]));
    return Array.from({ length: capacity }, (_, position) => ({
      position,
      item: byPosition.get(position) ?? null
    }));
  });

  /**
   * Apps flagged `requiresAdmin` are absent for everyone else, rather than present and
   * refusing — same rule the launcher has always applied, now scoped to whatever a player
   * actually placed on the grid instead of every installed app.
   */
  const visible = (appId: string): boolean => {
    const manifest = appRegistryStore.getManifest(appId);
    return Boolean(manifest) && (!manifest!.requiresAdmin || get(isAdmin));
  };

  function folderPreviewManifests(appIds: string[]) {
    return appIds
      .slice(0, 4)
      .map((id) => appRegistryStore.getManifest(id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
  }

  function attachAppIcon(node: HTMLElement, position: number) {
    const detach = attachLongPressDrag(node, {
      onLongPress: (e) => {
        const cell = cells.find((c) => c.position === position);
        if (!cell?.item || cell.item.kind !== 'app') return;
        const appId = cell.item.appId;
        const manifest = appRegistryStore.getManifest(appId) ?? null;
        startIconDrag(appId, { kind: 'grid', position }, e.clientX, e.clientY, manifest);
      },
      onDragMove: (x, y) => moveIconDrag(x, y),
      onDragEnd: (x, y) => {
        resolveIconDrop(get(iconDragState), resolveDropAtPoint(x, y));
      },
      onDragCancel: () => {}
    });
    return { destroy: detach };
  }

  function attachFolderIcon(node: HTMLElement, position: number) {
    const detach = attachLongPressDrag(node, {
      onLongPress: (e) => {
        const cell = cells.find((c) => c.position === position);
        if (!cell?.item || cell.item.kind !== 'folder') return;
        // Folders drag as a unit — there is no manifest to show in the ghost, so the
        // drag ghost simply renders nothing for a folder-kind drag (DragGhost only
        // renders when `manifest` is set).
        startIconDrag(cell.item.folderId, { kind: 'grid', position }, e.clientX, e.clientY, null);
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

<div
  role="region"
  aria-label="Home Screen"
  class="pt-safe-top text-on-surface flex h-full flex-col bg-transparent px-4 select-none"
>
  <!-- The "we are home" signal a large number of e2e specs already key off — kept as a
       real heading rather than folded into an aria-label, since dropping it would cascade
       into rewriting assertions in files this ticket has no reason to touch. -->
  <h1 class="mb-8 text-4xl font-bold tracking-tight">gPhone</h1>

  <div
    class="grid flex-1 content-start gap-y-6"
    style="grid-template-columns: repeat({$homeGridColumns}, 1fr);"
  >
    {#each cells as cell (cell.position)}
      <div data-position={cell.position} class="flex items-center justify-center">
        {#if cell.item?.kind === 'app' && visible(cell.item.appId)}
          {@const appId = cell.item.appId}
          {@const manifest = appRegistryStore.getManifest(appId)}
          {#if manifest}
            <div use:attachAppIcon={cell.position}>
              <AppIcon
                name={manifest.name}
                color={manifest.color}
                icon={manifest.icon}
                badgeStore={manifest.badgeStore}
                onclick={() => openApp(appId)}
              />
            </div>
          {/if}
        {:else if cell.item?.kind === 'folder'}
          {@const folder = cell.item}
          {@const previewApps = folderPreviewManifests(folder.appIds)}
          <div use:attachFolderIcon={cell.position} class="flex flex-col items-center gap-2">
            <button
              type="button"
              class="bg-surface-container h-14 w-14 cursor-pointer rounded-lg p-1.5 shadow-lg"
              onclick={() => openFolderId.set(folder.folderId)}
              aria-label={folder.name || 'Folder'}
            >
              <div class="grid h-full w-full grid-cols-2 grid-rows-2 gap-0.5">
                {#each previewApps as app (app.id)}
                  <div class="{app.color} flex items-center justify-center rounded-md">
                    {#if typeof app.icon === 'string'}
                      <img
                        src={app.icon}
                        alt=""
                        class="pointer-events-none h-3 w-3 object-contain"
                      />
                    {:else if app.icon}
                      {@const Icon = app.icon}
                      <Icon />
                    {/if}
                  </div>
                {/each}
              </div>
            </button>
            <span class="text-on-surface max-w-[72px] truncate px-1 text-xs font-medium"
              >{folder.name}</span
            >
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<FolderPopup {openApp} />
