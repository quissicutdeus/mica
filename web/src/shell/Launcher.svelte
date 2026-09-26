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
  import {
    layoutCells,
    homeEditMode,
    homeGridItems,
    openFolderId,
    placeWidgetOnGrid,
    removeFromGrid,
    widgetDimensions,
    type HomeGridItem,
    type WidgetSize
  } from './state/homeGrid';
  import { availableWidgets } from './state/widgets';
  import { toast } from './state/toast';
  import WidgetHost from './WidgetHost.svelte';
  import { pausedWidgets, resumeWidget } from './addon/widgetPause';
  import TrashIcon from '../../../sdk/ui/icons/TrashIcon.svelte';
  import { wallpaperNeedsContrast } from './state/wallpaper';
  import { descriptor } from './state/device';
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

  /**
   * Row-major: `position` 0 is top-left, increasing left-to-right then top-to-bottom.
   * Every cell is placed explicitly (`gridArea`) rather than left to auto-placement, since a
   * widget spans several and the cells under it are not drawn at all. Widgets claim their
   * footprint first, so data that overlaps (a column change not yet reflowed) draws the
   * widget and hides what it sits on rather than stacking two things in one place.
   */
  let cells = $derived(layoutCells($homeGridItems, $homeGridColumns, $homeGridRows));

  const areaOf = (position: number, item: HomeGridItem | null): string => {
    const row = Math.floor(position / $homeGridColumns) + 1;
    const col = (position % $homeGridColumns) + 1;
    if (item?.kind !== 'widget') return `grid-area: ${row} / ${col};`;
    const { cols, rows } = widgetDimensions(item.size);
    return `grid-area: ${row} / ${col} / span ${rows} / span ${cols};`;
  };

  const widgetEntry = (widgetId: string) => $availableWidgets.find((w) => w.widgetId === widgetId);

  // An add-on's widget opens that app when tapped: its frame is display-only, so the cell
  // takes the tap. A shell built-in has no app behind it, and a core app's widget is a
  // component that owns its own taps and controls (Music's transport) — wrapping that in a
  // button nests one interactive element inside another. In edit mode the cell is a plain
  // element, so a tap opens nothing.
  const openable = (widgetId: string) =>
    $availableWidgets.find((w) => w.widgetId === widgetId)?.render.kind === 'addon';

  let addSheetOpen = $state(false);
  let unplacedWidgets = $derived(
    $availableWidgets.filter(
      (w) => !$homeGridItems.some((i) => i.kind === 'widget' && i.widgetId === w.widgetId)
    )
  );
  const sizeLabel = (size: WidgetSize) =>
    size === '2x1' ? $t('shell.widgetSizeWide') : $t('shell.widgetSizeLarge');

  function addWidget(widgetId: string, size: WidgetSize) {
    if (placeWidgetOnGrid(widgetId, size) === 'rejected') {
      toast.show({ type: 'warning', message: $t('shell.noRoomForWidget') });
      return;
    }
    addSheetOpen = false;
  }

  function leaveEditMode() {
    addSheetOpen = false;
    homeEditMode.set(false);
  }

  /**
   * A held press on an empty cell enters edit mode; icons and widgets keep their own
   * long-press, which is a drag. Cells are keyed by position, so the same node goes from
   * empty to occupied (and back) without remounting — hence `update`, which attaches or
   * detaches the listener as the cell fills or empties.
   */
  function attachEmptyCell(node: HTMLElement, empty: boolean) {
    let detach: (() => void) | null = null;
    const sync = (isEmpty: boolean) => {
      if (isEmpty && !detach) {
        detach = attachLongPressDrag(node, {
          onLongPress: () => homeEditMode.set(true),
          onDragMove: () => {},
          onDragEnd: () => {},
          onDragCancel: () => {}
        });
      } else if (!isEmpty && detach) {
        detach();
        detach = null;
      }
    };
    sync(empty);
    return { update: sync, destroy: () => sync(false) };
  }

  /** Removing a widget also lifts a crash-loop pause on it, so adding it again boots it. */
  function removeWidgetAt(position: number, widgetId: string) {
    removeFromGrid(position);
    resumeWidget(widgetId);
  }

  /** Widgets move with the icons' own gesture (`iconDrag.ts`); with no manifest the ghost is blank, as for a folder. */
  function attachWidget(node: HTMLElement, position: number) {
    const detach = attachLongPressDrag(node, {
      onLongPress: (e) => {
        const cell = cells.find((c) => c.position === position);
        if (cell?.item?.kind !== 'widget') return;
        startIconDrag(cell.item.widgetId, { kind: 'grid', position }, e.clientX, e.clientY, null);
      },
      onDragMove: (x, y) => moveIconDrag(x, y),
      onDragEnd: (x, y) => {
        resolveIconDrop(get(iconDragState), resolveDropAtPoint(x, y));
      },
      onDragCancel: () => {}
    });
    return { destroy: detach };
  }

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
  class="pt-safe-top text-on-surface relative flex h-full flex-col bg-transparent px-4 select-none"
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
      {$descriptor.brand}
    </h1>
  </div>

  <!-- `grid-auto-rows` keeps a row of entirely empty cells the same height as one with an
       icon in it (roughly an `AppIcon` tile plus its label). Without it, a row nothing has
       been dropped into yet collapses to 0px — every `data-position` cell in it still
       exists in the DOM at that row's x-position, but with no height, so it occupies no
       actual screen area and there is nothing there for a drag-drop (or a tap) to land on.
       A brand-new player's home grid starts entirely empty (MICA-5), so this was not an
       edge case — it was the very first row anyone would ever try to drop an app onto. -->
  {#if $homeEditMode}
    <div class="mb-2 flex items-center justify-center gap-3" data-testid="home-edit-bar">
      <button
        type="button"
        class="bg-surface-container-high text-on-surface text-label-large cursor-pointer rounded-box px-4 py-2"
        onclick={() => (addSheetOpen = true)}>{$t('shell.addWidget')}</button
      >
      <button
        type="button"
        class="bg-primary text-on-primary text-label-large cursor-pointer rounded-box px-4 py-2"
        onclick={leaveEditMode}>{$t('shell.editDone')}</button
      >
    </div>
  {/if}
  <div
    class="grid flex-1 content-start gap-y-6"
    style="grid-template-columns: repeat({$homeGridColumns}, 1fr); grid-auto-rows: minmax(5.5rem, auto);"
  >
    {#each cells as cell (cell.position)}
      <div
        data-position={cell.position}
        class="items-center justify-center"
        class:flex={cell.item?.kind !== 'widget'}
        class:grid={cell.item?.kind === 'widget'}
        style={areaOf(cell.position, cell.item)}
        use:attachEmptyCell={!cell.item}
      >
        {#if cell.item?.kind === 'widget'}
          {@const widget = cell.item}
          {@const entry = widgetEntry(widget.widgetId)}
          <!-- An entry that is gone (the app was uninstalled) draws nothing and the item
               stays in `homeGridItems`, so reinstalling puts it back where it was. -->
          {#if entry && !$pausedWidgets.has(widget.widgetId)}
            {@const dragging =
              $iconDragState.origin?.kind === 'grid' &&
              $iconDragState.origin.position === cell.position &&
              $iconDragState.appId === widget.widgetId}
            {#if openable(widget.widgetId) && !$homeEditMode}
              <!-- The frame of an add-on's widget is display-only, so the cell takes the tap. -->
              <button
                type="button"
                data-testid="home-widget"
                data-widget-id={widget.widgetId}
                aria-label={$t('shell.openWidget', { name: entry.label })}
                onclick={() => openApp(widget.widgetId)}
                use:attachWidget={cell.position}
                class="relative min-h-0 min-w-0 cursor-pointer overflow-hidden rounded-box text-left"
                class:opacity-50={dragging}
              >
                <WidgetHost {entry} size={widget.size} />
              </button>
            {:else}
              <div
                data-testid="home-widget"
                data-widget-id={widget.widgetId}
                use:attachWidget={cell.position}
                class="relative min-h-0 min-w-0 overflow-hidden rounded-box"
                class:opacity-50={dragging}
              >
                <!-- Inert while editing: a widget's own buttons must not fire under a drag. -->
                <div class="h-full w-full" inert={$homeEditMode}>
                  <WidgetHost {entry} size={widget.size} />
                </div>
                {#if $homeEditMode}
                  <button
                    type="button"
                    aria-label={$t('shell.removeWidget', { name: entry.label })}
                    class="bg-surface-container-highest text-on-surface absolute top-1 right-1 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full"
                    onclick={() => removeWidgetAt(cell.position, widget.widgetId)}
                  >
                    <TrashIcon class="size-icon-sm" />
                  </button>
                {/if}
              </div>
            {/if}
          {:else if $homeEditMode || $pausedWidgets.has(widget.widgetId)}
            <!-- A widget with no entry (its app is uninstalled, disabled or unsupported) keeps
                 its footprint but draws nothing to the player; while editing it shows what it
                 is so it can be removed. A paused one (crash loop) is labelled outside edit
                 mode too, so the player knows why it is blank. -->
            {@const paused = $pausedWidgets.has(widget.widgetId)}
            <div
              data-testid="home-widget-placeholder"
              data-widget-id={widget.widgetId}
              use:attachWidget={cell.position}
              class="bg-surface-container text-on-surface-variant text-body-small relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-box p-2 text-center"
            >
              {paused ? $t('shell.widgetPaused') : $t('shell.widgetUnavailable')}
              {#if $homeEditMode}
                <button
                  type="button"
                  aria-label={$t('shell.removeWidget', { name: entry?.label ?? widget.widgetId })}
                  class="bg-surface-container-highest text-on-surface absolute top-1 right-1 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full"
                  onclick={() => removeWidgetAt(cell.position, widget.widgetId)}
                >
                  <TrashIcon class="size-icon-sm" />
                </button>
              {/if}
            </div>
          {/if}
        {:else if cell.item?.kind === 'app' && visible(cell.item.appId)}
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

{#if addSheetOpen}
  <div
    class="bg-scrim absolute inset-0 z-56 flex items-end"
    role="dialog"
    aria-modal="true"
    aria-label={$t('shell.addWidget')}
  >
    <div
      class="bg-surface-container shadow-elevation-5 pb-home-indicator flex w-full flex-col gap-3 rounded-box p-5"
    >
      <h2 class="text-on-surface text-title-medium">{$t('shell.addWidget')}</h2>
      {#each unplacedWidgets as widget (widget.widgetId)}
        <div class="flex items-center justify-between gap-2">
          <span class="text-on-surface text-body-medium min-w-0 truncate">{widget.label}</span>
          <div class="flex gap-2">
            {#each widget.sizes as size (size)}
              <button
                type="button"
                aria-label="{widget.label}, {sizeLabel(size)}"
                class="bg-surface-container-high text-on-surface text-label-large cursor-pointer rounded-box px-3 py-1.5"
                onclick={() => addWidget(widget.widgetId, size)}>{sizeLabel(size)}</button
              >
            {/each}
          </div>
        </div>
      {:else}
        <p class="text-on-surface-variant text-body-medium">{$t('shell.noWidgets')}</p>
      {/each}
      <button
        type="button"
        class="text-on-surface text-label-large cursor-pointer py-2"
        onclick={() => (addSheetOpen = false)}>{$t('shell.editDone')}</button
      >
    </div>
  </div>
{/if}

<FolderPopup {openApp} />
