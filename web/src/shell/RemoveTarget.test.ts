// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/svelte';
import RemoveTarget from './RemoveTarget.svelte';
import { cancelIconDrag, moveIconDrag, startIconDrag } from './state/iconDrag';

/**
 * MICA-87. The target is the whole affordance — long-pressing an icon pinned it and
 * nothing took it back off — so what matters here is *when it is on screen* and whether
 * the drop hit test can find it, not how the pill is styled.
 */
const rectAt = (el: Element, box: { left: number; top: number; width: number; height: number }) => {
  el.getBoundingClientRect = (): DOMRect => ({
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
    x: box.left,
    y: box.top,
    toJSON: () => ({})
  });
};

beforeEach(() => {
  cancelIconDrag();
});

describe('RemoveTarget', () => {
  it('stays hidden while nothing is being dragged', () => {
    const { queryByTestId } = render(RemoveTarget);
    expect(queryByTestId('remove-drop-target')).toBeNull();
  });

  it('appears for a home-grid drag', async () => {
    const { findByTestId } = render(RemoveTarget);
    startIconDrag('notes', { kind: 'grid', position: 3 }, 10, 10);
    expect(await findByTestId('remove-drop-target')).toBeTruthy();
  });

  it('appears for a drag out of an open folder', async () => {
    const { findByTestId } = render(RemoveTarget);
    startIconDrag('notes', { kind: 'folder', folderId: 'f1' }, 10, 10);
    expect(await findByTestId('remove-drop-target')).toBeTruthy();
  });

  it('stays hidden for a drawer drag — there is nothing pinned to remove', async () => {
    const { queryByTestId } = render(RemoveTarget);
    startIconDrag('notes', { kind: 'drawer' }, 10, 10);
    await Promise.resolve();
    expect(queryByTestId('remove-drop-target')).toBeNull();
  });

  it('carries the attribute resolveDropAtPoint hit-tests for', async () => {
    const { findByTestId } = render(RemoveTarget);
    startIconDrag('notes', { kind: 'grid', position: 3 }, 10, 10);
    const pill = await findByTestId('remove-drop-target');
    expect(pill.dataset.dropRemove).toBeDefined();
  });

  it('is not pointer-events-none, or elementsFromPoint could never return it', async () => {
    const { findByTestId } = render(RemoveTarget);
    startIconDrag('notes', { kind: 'grid', position: 3 }, 10, 10);
    const pill = await findByTestId('remove-drop-target');
    expect(pill.className).not.toContain('pointer-events-none');
  });

  it('arms only while the pointer is inside it', async () => {
    const { findByTestId } = render(RemoveTarget);
    startIconDrag('notes', { kind: 'grid', position: 3 }, 0, 0);
    const pill = await findByTestId('remove-drop-target');
    rectAt(pill, { left: 100, top: 40, width: 120, height: 36 });

    moveIconDrag(160, 58);
    expect((await findByTestId('remove-drop-target')).className).toContain('bg-error');

    moveIconDrag(160, 400);
    expect((await findByTestId('remove-drop-target')).className).not.toContain('bg-error');
  });

  it('disappears the moment the drag ends', async () => {
    const { queryByTestId, findByTestId } = render(RemoveTarget);
    startIconDrag('notes', { kind: 'grid', position: 3 }, 10, 10);
    await findByTestId('remove-drop-target');

    cancelIconDrag();
    await Promise.resolve();
    expect(queryByTestId('remove-drop-target')).toBeNull();
  });
});
