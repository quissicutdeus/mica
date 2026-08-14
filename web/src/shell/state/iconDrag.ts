import { get, writable } from 'svelte/store';
import type { AppManifest } from '@gphone/sdk';
import { dockAppIds, setDockSlot } from './dock';
import {
  moveGridItem,
  placeAppOnGrid,
  removeAppFromFolderOnly,
  removeFromGrid,
  type PlacementResult
} from './homeGrid';

export type DragOrigin =
  | { kind: 'drawer' }
  | { kind: 'grid'; position: number }
  | { kind: 'dock'; index: number }
  | { kind: 'folder'; folderId: string };

export interface IconDragState {
  appId: string | null;
  origin: DragOrigin | null;
  x: number;
  y: number;
  manifest: AppManifest | null;
}

const idle: IconDragState = { appId: null, origin: null, x: 0, y: 0, manifest: null };

export const iconDragState = writable<IconDragState>({ ...idle });

export function startIconDrag(
  appId: string,
  origin: DragOrigin,
  x: number,
  y: number,
  manifest: AppManifest | null = null
): void {
  iconDragState.set({ appId, origin, x, y, manifest });
}

export function moveIconDrag(x: number, y: number): void {
  iconDragState.update((state) => (state.appId ? { ...state, x, y } : state));
}

/** Drop was invalid or missed every target. Nothing was mutated speculatively, so this is
 *  just clearing the session — the source (grid cell, dock slot, folder) never moved. */
export function cancelIconDrag(): void {
  iconDragState.set({ ...idle });
}

export function endIconDrag(): void {
  iconDragState.set({ ...idle });
}

export type DropTarget = { kind: 'grid'; position: number } | { kind: 'dock'; index: number } | { kind: 'none' };

/**
 * The whole drag/drop decision matrix in one place, rather than duplicated hit-testing
 * logic in Dock/Launcher/FolderPopup. Each caller only has to compute *where* the pointer
 * landed (grid cell / dock slot / neither) and hand that plus the current drag state here.
 */
export function resolveIconDrop(state: IconDragState, target: DropTarget): PlacementResult | 'no-op' {
  if (!state.appId || !state.origin) return 'no-op';
  const { appId, origin } = state;

  if (target.kind === 'none') {
    cancelIconDrag();
    return 'rejected';
  }

  // Leaving a folder is committed the moment the app lands anywhere else — the folder
  // itself never re-gains the app if the placement below is rejected, since "rejected"
  // here means "the target cell/slot refused it", not "put it back where it came from".
  if (origin.kind === 'folder') removeAppFromFolderOnly(origin.folderId, appId);

  if (target.kind === 'dock') {
    // Dock slots always accept a drop, so the source is freed unconditionally.
    if (origin.kind === 'grid') removeFromGrid(origin.position);
    setDockSlot(target.index, appId);
    endIconDrag();
    return 'placed';
  }

  // target.kind === 'grid'
  let result: PlacementResult;
  if (origin.kind === 'drawer' || origin.kind === 'folder') {
    result = placeAppOnGrid(appId, target.position);
  } else if (origin.kind === 'grid') {
    result = moveGridItem(origin.position, target.position);
  } else {
    // origin.kind === 'dock' — pull it out of its slot and place it on the grid.
    result = placeAppOnGrid(appId, target.position);
    if (result !== 'rejected') clearDockSlotIfStillThere(origin.index, appId);
  }

  if (result === 'rejected') {
    cancelIconDrag();
    return 'rejected';
  }
  endIconDrag();
  return result;
}

function clearDockSlotIfStillThere(index: number, appId: string): void {
  const current = get(dockAppIds);
  if (current[index] === appId) setDockSlot(index, '');
}

/**
 * Hit-tests a viewport point against the drop targets rendered by `Dock.svelte`
 * (`data-dock-index`) and `Launcher.svelte` (`data-position`), so every drag origin
 * (drawer, grid, dock, folder) shares one hit-testing implementation instead of each
 * component reimplementing `elementsFromPoint`. Dock is checked first: the dock physically
 * overlaps the bottom rows of the home grid area's hit-box during a drag, and a drop meant
 * for a dock slot must not be swallowed by whatever grid cell happens to sit underneath it
 * in the DOM.
 */
export function resolveDropAtPoint(x: number, y: number): DropTarget {
  if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') {
    return { kind: 'none' };
  }
  const elements = document.elementsFromPoint(x, y) as HTMLElement[];
  for (const el of elements) {
    if (el.dataset?.dockIndex !== undefined) {
      return { kind: 'dock', index: Number(el.dataset.dockIndex) };
    }
  }
  for (const el of elements) {
    if (el.dataset?.position !== undefined) {
      return { kind: 'grid', position: Number(el.dataset.position) };
    }
  }
  return { kind: 'none' };
}
