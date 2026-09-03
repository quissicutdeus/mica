<!--
SPDX-FileCopyrightText: 2025 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { t } from './messages';
  import { anySheetOpen } from './state/sheets';
  import { badgeAllowed } from './state/notificationPolicy';
  import { get } from 'svelte/store';
  import { appVisible } from './state/appVisibility';
  import AppIcon from '../../../sdk/ui/AppIcon.svelte';
  import { attachLongPressDrag } from '../lib/phone/longPressDrag';
  import { attachDragGesture, clampProgress, shouldCommitDrag } from '../lib/phone/pointerDrag';
  import { abandonSheetDrag, DRAWER_OPEN_COMMIT } from '../lib/phone/sheetDrag';
  import { appRegistryStore } from './state/registry';
  import { homeGridColumns, homeGridRows } from './state/homeGridSettings';
  import { homeGridItems, openFolderId, type HomeGridItem } from './state/homeGrid';
  import { wallpaperNeedsContrast } from './state/wallpaper';
  import {
    iconDragState,
    resolveDropAtPoint,
    resolveIconDrop,
    startIconDrag,
    moveIconDrag
  } from './state/iconDrag';
  import { openDrawer, isDrawerOpen, drawerDragProgress, drawerDragPhase } from './state/appDrawer';
  import { openShade, isShadeOpen, shadeDragProgress, shadeDragPhase } from './state/shade';
  import { shadeDragRevealDistance } from './state/display';
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
   * `appRegistryStore.getManifest` reads the registry with a one-shot `get()`, which is
   * exactly wrong for the template: a bundled add-on already on the grid re-registers
   * asynchronously on every boot (`registry.ts`'s `installedAddOnIds.subscribe`), so the
   * cell for it rendered empty and stayed empty — nothing here ever re-ran once that
   * promise resolved, because nothing it read was reactive. `AppDrawer.svelte` never had
   * this bug; it dereferences `$appRegistryStore` directly. This does the same, once, so
   * `visible` and the template's own lookups all track it.
   */
  let manifestById = $derived(new Map($appRegistryStore.map((m) => [m.id, m])));

  /**
   * Apps the phone cannot honour — `requiresAdmin` without the ace, or a `requires`
   * capability this server does not have — are absent rather than present and refusing.
   * Scoped to whatever a player actually placed on the grid instead of every installed app.
   *
   * A grid cell whose app is hidden renders empty and the item stays in `homeGridItems`
   * untouched, deliberately: the placement is the player's and outlives the reason it is
   * not being drawn, so an admin ace granted (or a framework that comes back) restores the
   * icon where they left it rather than to the end of the drawer.
   */
  const visible = (appId: string): boolean => $appVisible(manifestById.get(appId));

  /**
   * The four mini-tiles drawn inside a folder icon, and they filter for the same reason the
   * grid above does. `FolderPopup` hides an app the phone cannot honour once the folder is
   * open; without this the closed folder still painted its tile colour and glyph, which is
   * the app announcing itself by another name. **Filtered before the slice**, so hiding one
   * promotes the next app into the preview rather than leaving a gap.
   */
  function folderPreviewManifests(appIds: string[]) {
    return appIds
      .map((id) => manifestById.get(id))
      .filter((m): m is NonNullable<typeof m> => $appVisible(m))
      .slice(0, 4);
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

  let homeScreenRef = $state<HTMLElement | null>(null);

  /**
   * A swipe anywhere on the empty home screen is a shortcut for the same two gestures
   * that already exist elsewhere — dragging the status bar down (`PhoneFrame.svelte`)
   * or the dock up (`Dock.svelte`) — rather than a third, independent action. Which one
   * it drives is decided once, by whichever direction the first committed move is in,
   * and stays that way for the rest of the gesture: reversing direction mid-drag moves
   * `deltaY` back toward (or past) zero, and since progress is recomputed from the raw
   * delta on every move rather than accumulated, that reads as the same drag rewinding
   * rather than switching to the other target.
   *
   * `shouldStart` refuses to arm on top of a `<button>` — an app icon, a folder, the
   * header — so this never competes with a tap-to-open or `attachLongPressDrag`'s own
   * pick-up-to-reposition gesture. It only ever sees pointerdown on genuinely empty grid
   * cells or the header band.
   */
  let swipeTarget: 'shade' | 'drawer' | null = null;

  function driveSwipeShortcut(deltaY: number): void {
    if (swipeTarget === null) {
      if (anySheetOpen()) return;
      swipeTarget = deltaY > 0 ? 'shade' : 'drawer';
    }
    if (swipeTarget === 'shade') {
      if (get(isShadeOpen)) return;
      shadeDragPhase.set('dragging');
      shadeDragProgress.set(clampProgress(deltaY / $shadeDragRevealDistance));
    } else {
      if (get(isDrawerOpen)) return;
      drawerDragPhase.set('dragging');
      drawerDragProgress.set(clampProgress(-deltaY / $shadeDragRevealDistance));
    }
  }

  $effect(() => {
    if (!homeScreenRef) return;
    return attachDragGesture(homeScreenRef, {
      axis: 'y',
      // Also refuses to arm while either overlay is already open — the home screen
      // stays mounted underneath both, and without this a swipe meant for the shade's
      // own close handle (or the drawer's) got captured and silently swallowed here
      // instead of ever reaching it, since `driveSwipeShortcut` no-ops once it sees
      // `isShadeOpen`/`isDrawerOpen` but only *after* this had already claimed the
      // pointer.
      shouldStart: (e) => !anySheetOpen() && !(e.target as HTMLElement).closest('button'),
      // `shouldStart` above has already excluded every icon and folder, so this only ever
      // runs on empty grid cells — there is no horizontal gesture left to yield to, and
      // cancelling on one just rejected any swipe that started a little sideways.
      crossAxisCancel: false,
      onMove: driveSwipeShortcut,
      onEnd: (deltaY, velocity) => {
        const target = swipeTarget;
        swipeTarget = null;
        if (target === 'shade') {
          if (get(isShadeOpen)) return;
          shadeDragPhase.set('settling');
          if (shouldCommitDrag(get(shadeDragProgress), velocity)) {
            shadeDragProgress.set(1);
            openShade();
          } else {
            shadeDragProgress.set(0);
          }
        } else if (target === 'drawer') {
          if (get(isDrawerOpen)) return;
          drawerDragPhase.set('settling');
          if (shouldCommitDrag(get(drawerDragProgress), -velocity, DRAWER_OPEN_COMMIT)) {
            drawerDragProgress.set(1);
            openDrawer();
          } else {
            drawerDragProgress.set(0);
          }
        }
      },
      onCancel: () => {
        // This one drives whichever sheet the swipe chose, so it has to undo the same one.
        // Left alone, that sheet stays at `'dragging'` and pins itself on screen for the
        // rest of the session (MICA-106).
        if (swipeTarget === 'shade') abandonSheetDrag(shadeDragPhase);
        else if (swipeTarget === 'drawer') abandonSheetDrag(drawerDragPhase);
        swipeTarget = null;
      }
    });
  });
</script>

<div
  bind:this={homeScreenRef}
  role="region"
  aria-label={$t('shell.homeScreen')}
  class="pt-safe-top text-on-surface flex h-full flex-col bg-transparent px-4 select-none"
>
  <!-- The "we are home" signal a large number of e2e specs already key off — kept as a
       real heading rather than folded into an aria-label, since dropping it would cascade
       into rewriting assertions in files this ticket has no reason to touch.

       Centered on both axes in its own band, rather than left-aligned text with a bottom
       margin: `h-16` gives the text equal breathing room above and below, between the
       status bar above and the first icon row below, instead of sitting flush against
       whichever edge it happens to be closest to. -->
  <div class="mb-4 flex h-16 items-center justify-center">
    <!-- Stroked over a photo wallpaper, like an `AppIcon` label (MICA-109). It is drawn
         straight onto whatever picture the player chose, and `text-on-surface` against an
         unknown photograph is a ratio nobody can state. `.text-on-wallpaper` makes the
         question answerable instead of guessed: the glyph keeps `on-surface` and gains a
         3px `surface`-coloured stroke, so what it is really read against is `surface` —
         16.28:1 in light and 14.30:1 in dark, whatever is behind it. -->
    <h1 class="text-4xl font-bold tracking-tight" class:text-on-wallpaper={$wallpaperNeedsContrast}>
      {$t('shell.brand')}
    </h1>
  </div>

  <!-- `grid-auto-rows` keeps a row of entirely empty cells the same height as one with an
       icon in it (roughly an `AppIcon` tile plus its label). Without it, a row nothing has
       been dropped into yet collapses to 0px — every `data-position` cell in it still
       exists in the DOM at that row's x-position, but with no height, so it occupies no
       actual screen area and there is nothing there for a drag-drop (or a tap) to land on.
       A brand-new player's home grid starts entirely empty (MICA-5), so this was not an
       edge case — it was the very first row anyone would ever try to drop an app onto. -->
  <div
    class="grid flex-1 content-start gap-y-6"
    style="grid-template-columns: repeat({$homeGridColumns}, 1fr); grid-auto-rows: minmax(5.5rem, auto);"
  >
    {#each cells as cell (cell.position)}
      <div data-position={cell.position} class="flex items-center justify-center">
        {#if cell.item?.kind === 'app' && visible(cell.item.appId)}
          {@const appId = cell.item.appId}
          {@const manifest = manifestById.get(appId)}
          {#if manifest}
            <div use:attachAppIcon={cell.position}>
              <AppIcon
                name={manifest.name}
                badgeSuppressed={!$badgeAllowed(appId)}
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
              class="bg-surface-container shadow-elevation-3 h-14 w-14 cursor-pointer rounded-box p-1.5"
              onclick={() => openFolderId.set(folder.folderId)}
              aria-label={folder.name || 'Folder'}
            >
              <div class="grid h-full w-full grid-cols-2 grid-rows-2 gap-0.5">
                {#each previewApps as app (app.id)}
                  <div class="{app.color} flex items-center justify-center rounded-box">
                    {#if typeof app.icon === 'string'}
                      <img
                        src={app.icon}
                        alt=""
                        class="pointer-events-none h-3 w-3 object-contain"
                      />
                    {:else if app.icon}
                      {@const Icon = app.icon}
                      <!-- Sized explicitly: an icon left to its own default paints h-8 w-8,
                           which is larger than the mosaic cell holding it. -->
                      <Icon class="h-3 w-3" />
                    {/if}
                  </div>
                {/each}
              </div>
            </button>
            <span class="text-on-surface text-body-small max-w-[72px] truncate px-1"
              >{folder.name}</span
            >
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<FolderPopup {openApp} />
