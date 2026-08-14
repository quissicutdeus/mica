import { get, writable } from 'svelte/store';
import { usePersisted } from '../../sdk/hooks/usePersisted';
import { homeGridColumns, homeGridRows } from './homeGridSettings';

/** Which folder's popup is open, if any — shell-owned UI state, not persisted. */
export const openFolderId = writable<string | null>(null);

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

export type HomeGridItem = HomeGridApp | HomeGridFolder;

export type PlacementResult = 'placed' | 'folder-created' | 'added-to-folder' | 'rejected';

const gridCapacity = (): number => get(homeGridColumns) * get(homeGridRows);

const isValidItem = (value: unknown): value is HomeGridItem => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.position !== 'number' || !Number.isInteger(v.position) || v.position < 0) return false;
  if (v.kind === 'app') return typeof v.appId === 'string' && v.appId.length > 0;
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
    const id = item.kind === 'app' ? item.appId : item.folderId;
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

export const homeGridItems = usePersisted<HomeGridItem[]>('settings', 'homeGridItems', [], {
  sanitize: sanitizeHomeGridItems
});

export const isGridCellOccupied = (position: number, items: HomeGridItem[]): boolean =>
  items.some((item) => item.position === position);

const itemAt = (position: number, items: HomeGridItem[]): HomeGridItem | undefined =>
  items.find((item) => item.position === position);

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
  const target = itemAt(targetPosition, items);

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
      next: [...items.filter((item) => item.position !== targetPosition), folder]
    };
  }

  // target.kind === 'folder'
  if (target.appIds.includes(draggedAppId)) return { result: 'rejected', next: items };
  if (target.appIds.length >= gridCapacity()) return { result: 'rejected', next: items };
  const updatedFolder: HomeGridFolder = { ...target, appIds: [...target.appIds, draggedAppId] };
  return {
    result: 'added-to-folder',
    next: items.map((item) => (item.position === targetPosition ? updatedFolder : item))
  };
}

/** Drop from the App Drawer — the dragged app has no existing grid cell to vacate. */
export function placeAppOnGrid(appId: string, position: number): PlacementResult {
  const current = get(homeGridItems);
  const { result, next } = resolveDrop(appId, position, current);
  if (result !== 'rejected') homeGridItems.set(next);
  return result;
}

/** Drag an already-placed app or folder to a new cell. */
export function moveGridItem(fromPosition: number, toPosition: number): PlacementResult {
  if (fromPosition === toPosition) return 'rejected';
  const current = get(homeGridItems);
  const source = itemAt(fromPosition, current);
  if (!source) return 'rejected';

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
 * Called after `homeGridColumns`/`homeGridRows` shrinks. Sanitization only fixes
 * structurally invalid data (see `sanitizeHomeGridItems`); an item whose `position` is
 * merely out of range for the *new*, smaller grid is a size-dependent problem, not a
 * structural one, and belongs here — right where the resize actually happens — rather than
 * in the sanitizer. Reflows every out-of-range item into the first free in-bounds cell;
 * once the grid is entirely full, remaining out-of-range items are dropped rather than
 * left invisible and unreachable.
 */
export function compactGridToCurrentCapacity(): void {
  const capacity = gridCapacity();
  const current = get(homeGridItems);
  const inBounds = current.filter((item) => item.position < capacity);
  const outOfBounds = current.filter((item) => item.position >= capacity);
  if (outOfBounds.length === 0) return;

  const occupied = new Set(inBounds.map((item) => item.position));
  const result = [...inBounds];
  for (const item of outOfBounds) {
    let free = -1;
    for (let p = 0; p < capacity; p++) {
      if (!occupied.has(p)) {
        free = p;
        break;
      }
    }
    if (free === -1) break; // grid is entirely full — nowhere left to put the rest
    occupied.add(free);
    result.push({ ...item, position: free } as HomeGridItem);
  }
  homeGridItems.set(result);
}

export function removeFromGrid(position: number): void {
  homeGridItems.update((items) => items.filter((item) => item.position !== position));
}

export function renameFolder(folderId: string, name: string): void {
  homeGridItems.update((items) =>
    items.map((item) => (item.kind === 'folder' && item.folderId === folderId ? { ...item, name } : item))
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
  homeGridItems.set([...otherItems, ...updatedFolder, { position: freePosition, kind: 'app', appId }]);
  return true;
}
