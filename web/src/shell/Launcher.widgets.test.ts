// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../host/registerFacets';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';

const resumeWidget = vi.hoisted(() => vi.fn());
vi.mock('./addon/widgetPause', async () => {
  const { writable } = await import('svelte/store');
  const paused = writable<ReadonlySet<string>>(new Set());
  return {
    pausedWidgets: { subscribe: paused.subscribe },
    setPaused: (ids: string[]) => paused.set(new Set(ids)),
    resumeWidget: (id: string) => resumeWidget(id),
    markWidgetBooting: () => {},
    markWidgetSettled: () => {}
  };
});

// @ts-expect-error -- the mock's own test seam, absent from the real module
import { setPaused } from './addon/widgetPause';
import Home from './Launcher.svelte';
import { isAdmin } from '../services/admin';
import { homeEditMode, homeGridItems } from './state/homeGrid';
import { homeGridColumns, homeGridRows } from './state/homeGridSettings';

if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

beforeEach(() => {
  isAdmin.set(true);
  homeGridItems.set([]);
  homeGridColumns.set(4);
  homeGridRows.set(5);
  homeEditMode.set(false);
  setPaused([]);
  resumeWidget.mockClear();
});

const holdOn = async (cell: HTMLElement) => {
  await fireEvent.pointerDown(cell, { pointerId: 1, clientX: 5, clientY: 5 });
  vi.advanceTimersByTime(600);
  await Promise.resolve();
  await fireEvent.pointerUp(window, { pointerId: 1 });
};

describe('the empty-cell long press', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stops entering edit mode once an icon lands in a cell that was empty at mount', async () => {
    const { container } = render(Home, { props: { openApp: () => {} } });
    homeGridItems.set([{ position: 7, kind: 'app', appId: 'contacts' }]);
    await Promise.resolve();
    await holdOn(container.querySelector('[data-position="7"]') as HTMLElement);
    expect(get(homeEditMode)).toBe(false);
  });

  it('starts entering edit mode once a cell that held an icon is emptied', async () => {
    homeGridItems.set([{ position: 7, kind: 'app', appId: 'contacts' }]);
    const { container } = render(Home, { props: { openApp: () => {} } });
    homeGridItems.set([]);
    await Promise.resolve();
    await holdOn(container.querySelector('[data-position="7"]') as HTMLElement);
    expect(get(homeEditMode)).toBe(true);
  });
});

describe('a widget that cannot be drawn', () => {
  const gone = { position: 0, kind: 'widget', widgetId: 'gone-app', size: '2x1' } as const;

  it('is invisible outside edit mode', () => {
    homeGridItems.set([gone]);
    const { container } = render(Home, { props: { openApp: () => {} } });
    expect(container.querySelector('[data-testid="home-widget-placeholder"]')).toBeNull();
  });

  it('shows a placeholder with a working remove button in edit mode', async () => {
    homeGridItems.set([gone]);
    homeEditMode.set(true);
    const { container, getByLabelText } = render(Home, { props: { openApp: () => {} } });
    expect(container.querySelector('[data-testid="home-widget-placeholder"]')).not.toBeNull();
    await fireEvent.click(getByLabelText('Remove widget gone-app'));
    expect(get(homeGridItems)).toEqual([]);
  });

  it('labels a paused widget outside edit mode, and removing it lifts the pause', async () => {
    homeGridItems.set([gone]);
    setPaused(['gone-app']);
    const { getByText, getByLabelText } = render(Home, { props: { openApp: () => {} } });
    expect(getByText('Widget paused')).not.toBeNull();
    homeEditMode.set(true);
    await Promise.resolve();
    await fireEvent.click(getByLabelText('Remove widget gone-app'));
    expect(resumeWidget).toHaveBeenCalledWith('gone-app');
    expect(get(homeGridItems)).toEqual([]);
  });
});
