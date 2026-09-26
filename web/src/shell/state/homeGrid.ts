// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import type { WidgetSize } from '../../../../sdk/manifest';
import { perDevice } from './device';
import { homeGridColumns, homeGridRows } from './homeGridSettings';

/** Which folder's popup is open, if any — shell-owned UI state, not persisted. */
export const openFolderId = writable<string | null>(null);

/** Whether the home screen is in edit mode (MICA-245) — shell-owned UI state, not persisted. */
export const homeEditMode = writable(false);

export interface HomeGridApp {
  position: number;
  kind: 'app';
  appId: string;
}

export interface HomeGridFolder {
  position: number;
  kind: 'folder';
  folderId: string;
  name: string;
  appIds: string[];
}

export type { WidgetSize };

const WIDGET_DIMENSIONS: Record<WidgetSize, { cols: number; rows: number }> = {
  '2x1': { cols: 2, rows: 1 },
  '2x2': { cols: 2, rows: 2 }
};

export const isWidgetSize = (value: unknown): value is WidgetSize =>
  value === '2x1' || value === '2x2';

/**
 * A widget. `position` is its **top-left** cell, as a flat row-major index at the current
 * column count — the same coordinate an icon uses — and the other cells it covers are
 * derived (`cellsOf`), never stored, so a layout written before widgets existed loads
 * unchanged. An unknown `widgetId` (the app was uninstalled) stays in the array, hidden:
 * the placement is the player's and survives an uninstall/reinstall round trip.
 */
export interface HomeGridWidget {
  position: number;
  kind: 'widget';
  widgetId: string;
  size: WidgetSize;
}

export type HomeGridItem = HomeGridApp | HomeGridFolder | HomeGridWidget;

export type PlacementResult = 'placed' | 'folder-created' | 'added-to-folder' | 'rejected';

const gridCapacity = (): number => get(homeGridColumns) * get(homeGridRows);

const isValidItem = (value: unknown): value is HomeGridItem => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.position !== 'number' || !Number.isInteger(v.position) || v.position < 0)
    return false;
  if (v.kind === 'app') return typeof v.appId === 'string' && v.appId.length > 0;
  if (v.kind === 'widget') {
    return typeof v.widgetId === 'string' && v.widgetId.length > 0 && isWidgetSize(v.size);
  }
  if (v.kind === 'folder') {
    return (
      typeof v.folderId === 'string' &&
      v.folderId.length > 0 &&
      typeof v.name === 'string' &&
      Array.isArray(v.appIds) &&
      v.appIds.every((id) => typeof id === 'string')
    );
  }
  return false;
};

/**
 * Structural validation only. Whether an item's `position` is still in range for the
 * *current* grid size is a separate, size-dependent policy — the compaction pass
 * triggered by resizing the grid (called from the Display settings pane) — so this stays a
 * pure function of the stored value alone and is testable without the settings stores.
 */
export function sanitizeHomeGridItems(value: unknown): HomeGridItem[] {
  if (!Array.isArray(value)) return [];
  const valid = value.filter(isValidItem);

  const byPosition = new Map<number, HomeGridItem>();
  const seenIds = new Map<string, number>(); // id -> index in the deduped-by-id pass

  // Dedupe by id first (last wins), preserving original order otherwise.
  const dedupedById: HomeGridItem[] = [];
  for (const item of valid) {
    // Widgets are keyed apart so a widget and an app sharing an id never collide.
    const id =
      item.kind === 'app'
        ? item.appId
        : item.kind === 'folder'
          ? item.folderId
          : `widget:${item.widgetId}`;
    const existingIndex = seenIds.get(id);
    if (existingIndex !== undefined) {
      dedupedById[existingIndex] = item;
    } else {
      seenIds.set(id, dedupedById.length);
      dedupedById.push(item);
    }
  }

  // Dedupe by position (first wins).
  const result: HomeGridItem[] = [];
  for (const item of dedupedById) {
    if (byPosition.has(item.position)) continue;
    byPosition.set(item.position, item);
    result.push(item);
  }

  return result;
}

/**
 * One grid per device, following `activeDevice` (MICA-259) — see `perDevice`. The
 * phone's key is `homeGridItems`, exactly as before, so an existing layout and every e2e
 * seed still mean the phone; the tablet's lives under `homeGridItems:tablet`.
 */
export const homeGridItems = perDevice<HomeGridItem[]>(
  'homeGridItems',
  () => [],
  sanitizeHomeGridItems
);

/** Every cell index `item` covers at `columns` columns — one for an icon, up to four for a widget. */
export function cellsOf(item: HomeGridItem, columns: number): number[] {
  if (item.kind !== 'widget') return [item.position];
  const { cols, rows } = WIDGET_DIMENSIONS[item.size];
  const cells: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells.push(item.position + r * columns + c);
  }
  return cells;
}

/** Whether a widget of `size` anchored at `position` sits wholly inside the grid, never straddling a row end. */
export function widgetFitsAt(
  position: number,
  size: WidgetSize,
  columns: number,
  rows: number
): boolean {
  const { cols, rows: h } = WIDGET_DIMENSIONS[size];
  return (
    position >= 0 &&
    (position % columns) + cols <= columns &&
    Math.floor(position / columns) + h <= rows
  );
}

export const widgetDimensions = (size: WidgetSize) => WIDGET_DIMENSIONS[size];

/** Whether any item covers the cell — a widget occupies every cell of its footprint. */
export const isGridCellOccupied = (position: number, items: HomeGridItem[]): boolean => {
  const columns = get(homeGridColumns);
  return items.some((item) => cellsOf(item, columns).includes(position));
};

/** The item anchored exactly at `position` — the cell an icon or a widget's top-left sits on. */
const itemAt = (position: number, items: HomeGridItem[]): HomeGridItem | undefined =>
  items.find((item) => item.position === position);

/** The item covering `position`, whichever of its cells that is. */
const coveringItem = (position: number, items: HomeGridItem[]): HomeGridItem | undefined => {
  const columns = get(homeGridColumns);
  return items.find((item) => cellsOf(item, columns).includes(position));
};

const generateFolderId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `folder-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Resolve dropping `draggedAppId` onto `targetPosition`, given the items the drag didn't
 * originate from (i.e. with the dragged item's own old cell, if any, already removed).
 * Shared by `placeAppOnGrid` (drawer origin, nothing to remove) and `moveGridItem`
 * (grid origin, old cell already excluded by the caller).
 */
function resolveDrop(
  draggedAppId: string,
  targetPosition: number,
  items: HomeGridItem[]
): { result: PlacementResult; next: HomeGridItem[] } {
  const target = coveringItem(targetPosition, items);

  // An icon dropped on a widget is refused: it neither merges into a folder nor displaces it.
  if (target?.kind === 'widget') return { result: 'rejected', next: items };

  if (!target) {
    return {
      result: 'placed',
      next: [...items, { position: targetPosition, kind: 'app', appId: draggedAppId }]
    };
  }

  if (target.kind === 'app') {
    if (target.appId === draggedAppId) return { result: 'rejected', next: items };
    const folder: HomeGridFolder = {
      position: targetPosition,
      kind: 'folder',
      folderId: generateFolderId(),
      name: '',
      appIds: [target.appId, draggedAppId]
    };
    return {
      result: 'folder-created',
      next: [...items.filter((item) => item !== target), folder]
    };
  }

  // target.kind === 'folder'
  if (target.appIds.includes(draggedAppId)) return { result: 'rejected', next: items };
  if (target.appIds.length >= gridCapacity()) return { result: 'rejected', next: items };
  const updatedFolder: HomeGridFolder = { ...target, appIds: [...target.appIds, draggedAppId] };
  return {
    result: 'added-to-folder',
    next: items.map((item) => (item === target ? updatedFolder : item))
  };
}

/** Drop from the App Drawer — the dragged app has no existing grid cell to vacate. */
export function placeAppOnGrid(appId: string, position: number): PlacementResult {
  const current = get(homeGridItems);
  const { result, next } = resolveDrop(appId, position, current);
  if (result !== 'rejected') homeGridItems.set(next);
  return result;
}

/**
 * Installing an add-on from the Store puts it on the home screen, at the first free
 * cell — the same expectation a player already has of a bare app icon, not something
 * they should have to know the App Drawer exists to satisfy. A no-op if the app is
 * already placed (an app or inside a folder) or the grid is entirely full; either way
 * the app stays reachable from the drawer.
 */
export function placeOnHomeGridIfAbsent(appId: string): void {
  const current = get(homeGridItems);
  const alreadyPlaced = current.some(
    (item) =>
      (item.kind === 'app' && item.appId === appId) ||
      (item.kind === 'folder' && item.appIds.includes(appId))
  );
  if (alreadyPlaced) return;

  const capacity = gridCapacity();
  for (let position = 0; position < capacity; position++) {
    if (!isGridCellOccupied(position, current)) {
      homeGridItems.set([...current, { position, kind: 'app', appId }]);
      return;
    }
  }
}

/** Drag an already-placed app or folder to a new cell. */
export function moveGridItem(fromPosition: number, toPosition: number): PlacementResult {
  if (fromPosition === toPosition) return 'rejected';
  const current = get(homeGridItems);
  const source = itemAt(fromPosition, current);
  if (!source) return 'rejected';

  if (source.kind === 'widget') return moveWidget(source, toPosition, current);

  if (source.kind === 'folder') {
    // Folders only move onto empty cells — merging a folder into another folder or app is
    // out of scope (unbounded-recursion edge case the ticket never asked for).
    if (isGridCellOccupied(toPosition, current)) return 'rejected';
    homeGridItems.set([
      ...current.filter((item) => item.position !== fromPosition),
      { ...source, position: toPosition }
    ]);
    return 'placed';
  }

  const withoutSource = current.filter((item) => item.position !== fromPosition);
  const { result, next } = resolveDrop(source.appId, toPosition, withoutSource);
  if (result !== 'rejected') homeGridItems.set(next);
  return result;
}

/**
 * Moves a widget so its top-left lands on `toPosition`, nudged inward if that would run
 * off the right or bottom edge (the player drops wherever the pointer is, which is rarely
 * the widget's own corner). Refused if any covered cell is held by something else.
 */
function moveWidget(
  source: HomeGridWidget,
  toPosition: number,
  current: HomeGridItem[]
): PlacementResult {
  const columns = get(homeGridColumns);
  const rows = get(homeGridRows);
  const { cols, rows: h } = WIDGET_DIMENSIONS[source.size];
  const col = Math.min(toPosition % columns, columns - cols);
  const row = Math.min(Math.floor(toPosition / columns), rows - h);
  const position = row * columns + col;
  if (position === source.position) return 'rejected';
  if (!widgetFitsAt(position, source.size, columns, rows)) return 'rejected';
  const others = current.filter((item) => item !== source);
  const moved: HomeGridWidget = { ...source, position };
  if (cellsOf(moved, columns).some((cell) => isGridCellOccupied(cell, others))) return 'rejected';
  homeGridItems.set([...others, moved]);
  return 'placed';
}

/**
 * Places a widget from the Add-widget sheet at the first free rectangle that holds it.
 * Refused if that widget is already on the grid (one instance each) or nothing fits.
 */
export function placeWidgetOnGrid(widgetId: string, size: WidgetSize): PlacementResult {
  const current = get(homeGridItems);
  if (current.some((item) => item.kind === 'widget' && item.widgetId === widgetId)) {
    return 'rejected';
  }
  const columns = get(homeGridColumns);
  const rows = get(homeGridRows);
  for (let position = 0; position < columns * rows; position++) {
    if (!widgetFitsAt(position, size, columns, rows)) continue;
    const widget: HomeGridWidget = { position, kind: 'widget', widgetId, size };
    if (cellsOf(widget, columns).some((cell) => isGridCellOccupied(cell, current))) continue;
    homeGridItems.set([...current, widget]);
    return 'placed';
  }
  return 'rejected';
}

/**
 * Lays `items` out on a `columns × rows` grid, moving as little as possible: whatever
 * already sits validly stays, widgets claiming their cells before icons do; the rest land
 * in the first free rectangle (widgets first) or cell. Pure. `unplaced` counts what had
 * nowhere to go — `items` is then only a partial answer and callers must not apply it.
 */
export function reflowItems(
  items: HomeGridItem[],
  columns: number,
  rows: number
): { items: HomeGridItem[]; unplaced: number } {
  const capacity = columns * rows;
  const taken = new Set<number>();
  const result: HomeGridItem[] = [];
  const displaced: HomeGridItem[] = [];

  const claim = (item: HomeGridItem) => {
    for (const cell of cellsOf(item, columns)) taken.add(cell);
    result.push(item);
  };
  const free = (item: HomeGridItem) => cellsOf(item, columns).every((cell) => !taken.has(cell));

  for (const item of items) {
    if (item.kind !== 'widget') continue;
    if (widgetFitsAt(item.position, item.size, columns, rows) && free(item)) claim(item);
    else displaced.push(item);
  }
  for (const item of items) {
    if (item.kind === 'widget') continue;
    if (item.position < capacity && free(item)) claim(item);
    else displaced.push(item);
  }

  let unplaced = 0;
  const order = [
    ...displaced.filter((i) => i.kind === 'widget'),
    ...displaced.filter((i) => i.kind !== 'widget')
  ];
  for (const item of order) {
    let placed = false;
    for (let position = 0; position < capacity && !placed; position++) {
      const candidate = { ...item, position };
      if (candidate.kind === 'widget' && !widgetFitsAt(position, candidate.size, columns, rows)) {
        continue;
      }
      if (!free(candidate)) continue;
      claim(candidate);
      placed = true;
    }
    if (!placed) unplaced++;
  }
  return { items: result, unplaced };
}

/**
 * How many currently-placed items would have nowhere to go at `capacity` cells.
 *
 * Pure — reads `homeGridItems` but touches nothing — so `setHomeGridSize` (MICA-121) can
 * ask this *before* it writes the new `homeGridColumns`/`homeGridRows`, and refuse the
 * resize outright rather than applying it and finding out afterward. Every top-level item
 * (an app, or a folder — a folder's contents never claim a grid cell of their own) needs
 * exactly one cell, so this is just item count against capacity.
 */
export function itemsBeyondCapacity(capacity: number, columns?: number): number {
  const items = get(homeGridItems);
  // With the column count in hand this is the real answer — a 2x2 widget can fail to pack
  // into a grid whose cell count is enough. Without it, the area alone is a lower bound.
  if (columns !== undefined && columns > 0) {
    return reflowItems(items, columns, Math.floor(capacity / columns)).unplaced;
  }
  const area = items.reduce(
    (sum, item) =>
      sum +
      (item.kind === 'widget'
        ? WIDGET_DIMENSIONS[item.size].cols * WIDGET_DIMENSIONS[item.size].rows
        : 1),
    0
  );
  return Math.max(0, area - capacity);
}

/**
 * Called after `homeGridColumns`/`homeGridRows` shrinks. Sanitization only fixes
 * structurally invalid data (see `sanitizeHomeGridItems`); an item whose `position` is
 * merely out of range for the *new*, smaller grid is a size-dependent problem, not a
 * structural one, and belongs here — right where the resize actually happens — rather than
 * in the sanitizer. Reflows every out-of-range item into the first free in-bounds cell.
 *
 * MICA-121: if the new capacity cannot hold every item, this makes **no change at all**
 * rather than reflowing what fits and quietly dropping the rest onto the floor — a partial
 * compaction is still data loss, just less of it, and it is exactly as silent either way.
 * `setHomeGridSize` is expected to check `itemsBeyondCapacity` and refuse the resize before
 * ever calling this, so the ordinary path never reaches the no-op branch below; it stays
 * here as the backstop for any other caller, present or future, that skips that check.
 * Returns how many items could not be placed — 0 means every item is now in bounds,
 * whether or not anything actually moved.
 */
export function compactGridToCurrentCapacity(): number {
  const current = get(homeGridItems);
  const { items, unplaced } = reflowItems(current, get(homeGridColumns), get(homeGridRows));
  if (unplaced > 0) return unplaced; // would still lose items — change nothing
  // Widgets are reflowed too (MICA-245): a shrink from 5 to 3 columns can leave one
  // straddling a row end or under an icon, and it moves rather than being destroyed.
  const moved = items.length !== current.length || items.some((item) => !current.includes(item));
  if (moved) homeGridItems.set(items);
  return 0;
}

export function removeFromGrid(position: number): void {
  homeGridItems.update((items) => items.filter((item) => item.position !== position));
}

export function renameFolder(folderId: string, name: string): void {
  homeGridItems.update((items) =>
    items.map((item) =>
      item.kind === 'folder' && item.folderId === folderId ? { ...item, name } : item
    )
  );
}

/**
 * Removes an app from a folder without placing it anywhere — the caller (drag-drop
 * resolution) is about to place it at a specific target cell or dock slot itself.
 */
export function removeAppFromFolderOnly(folderId: string, appId: string): void {
  homeGridItems.update((items) =>
    items
      .map((item) =>
        item.kind === 'folder' && item.folderId === folderId
          ? { ...item, appIds: item.appIds.filter((id) => id !== appId) }
          : item
      )
      .filter((item) => !(item.kind === 'folder' && item.appIds.length === 0))
  );
}

/**
 * Pulls one app out of a folder and back onto the grid, at the first free cell. If the
 * grid is entirely full the app is dropped from the folder with nowhere to land — reported
 * via the boolean return so the caller (the drag-out gesture) can leave the ghost/app where
 * it was instead of silently discarding it.
 */
export function removeAppFromFolder(folderId: string, appId: string): boolean {
  const current = get(homeGridItems);
  const folder = current.find(
    (item): item is HomeGridFolder => item.kind === 'folder' && item.folderId === folderId
  );
  if (!folder || !folder.appIds.includes(appId)) return false;

  const remainingAppIds = folder.appIds.filter((id) => id !== appId);
  const capacity = gridCapacity();
  const folderStays = remainingAppIds.length > 0;
  const otherItems = current.filter((item) => item.position !== folder.position);

  let freePosition = -1;
  for (let p = 0; p < capacity; p++) {
    if (!folderStays && p === folder.position) continue; // folder's own cell frees up
    if (p === folder.position && folderStays) continue; // still occupied by the shrunk folder
    if (!isGridCellOccupied(p, otherItems)) {
      freePosition = p;
      break;
    }
  }
  if (freePosition === -1) return false;

  const updatedFolder: HomeGridItem[] = folderStays ? [{ ...folder, appIds: remainingAppIds }] : [];
  homeGridItems.set([
    ...otherItems,
    ...updatedFolder,
    { position: freePosition, kind: 'app', appId }
  ]);
  return true;
}

/**
 * What the launcher draws, cell by cell. Widgets claim their footprint first, so data that
 * overlaps (a column change not yet reflowed) draws the widget and hides what it sits on
 * rather than stacking two things in one place; the cells under a widget are omitted.
 */
export function layoutCells(
  items: HomeGridItem[],
  columns: number,
  rows: number
): { position: number; item: HomeGridItem | null }[] {
  const covered = new Set<number>();
  const anchors = new Map<number, HomeGridItem>();
  for (const item of items) {
    if (item.kind !== 'widget' || !widgetFitsAt(item.position, item.size, columns, rows)) continue;
    const footprint = cellsOf(item, columns);
    if (footprint.some((cell) => covered.has(cell))) continue;
    for (const cell of footprint) covered.add(cell);
    anchors.set(item.position, item);
  }
  for (const item of items) {
    if (item.kind !== 'widget' && !covered.has(item.position)) anchors.set(item.position, item);
  }
  const result: { position: number; item: HomeGridItem | null }[] = [];
  for (let position = 0; position < columns * rows; position++) {
    const item = anchors.get(position) ?? null;
    if (covered.has(position) && item?.kind !== 'widget') continue;
    result.push({ position, item });
  }
  return result;
}
