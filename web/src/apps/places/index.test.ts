// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import { renderApp } from '@mica/sdk/testing';
import type { SavedPlace } from '@mica/shared/types';

const fixture = vi.hoisted(() => ({
  setWaypoint: vi.fn(),
  places: [] as unknown[]
}));

vi.mock('@mica/sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@mica/sdk')>();
  return {
    ...sdk,
    useLocation: () => ({ ...sdk.useLocation(), setWaypoint: fixture.setWaypoint })
  };
});

// The CRUD store reads through the transport, which a spy on `fetchNui` would miss; the app's
// own store module is the seam.
vi.mock('./store', () => {
  const list = {
    subscribe: (fn: (v: unknown[]) => void) => (fn(fixture.places), () => {}),
    loaded: readable(true),
    load: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined)
  };
  return {
    savedPlaces: list,
    useSavedPlaces: () => ({
      savedPlacesStore: list,
      addSavedPlace: vi.fn(),
      renameSavedPlace: vi.fn(),
      deleteSavedPlace: vi.fn()
    })
  };
});

vi.mock('./live', async (importOriginal) => {
  const live = await importOriginal<typeof import('./live')>();
  return {
    ...live,
    loadMapConfig: vi.fn().mockResolvedValue(live.DEFAULT_MAP_CONFIG),
    refreshLive: vi.fn().mockResolvedValue(undefined)
  };
});

import Places from './index.svelte';

// The map tab is the front page, and jsdom has no `ResizeObserver` for it to measure with.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const place = (id: number, name: string, x: number | null, y: number | null): SavedPlace =>
  ({ id, name, street_label: '', x, y, z: 0 }) as unknown as SavedPlace;

/**
 * MICA-472: the server sends `x`/`y` as null for a saved place whose stored position will not
 * parse, and since MICA-466 the client refuses anything but two finite numbers. The button was
 * still offered, and a tap could only end in "Could not set waypoint".
 */
describe('Places: Set waypoint', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fixture.setWaypoint.mockReset().mockResolvedValue(undefined);
    fixture.places = [place(1, 'Home', 215.3, -810.6), place(2, 'Lost', null, null)];
  });

  const openList = async () => {
    renderApp(Places, { id: 'places' });
    await fireEvent.click(await screen.findByRole('button', { name: 'List' }));
  };

  it('is disabled, with the reason shown, for a place with no usable position', async () => {
    await openList();

    const lost = screen.getByRole('button', { name: 'Set waypoint to Lost' });
    expect((lost as HTMLButtonElement).disabled).toBe(true);
    // One row says why, and only the row it is true of.
    expect(screen.getAllByText('No usable position saved')).toHaveLength(1);
  });

  it('draws no map pin for a place with no usable position', async () => {
    // The map draws pins only once it has a size, and jsdom lays nothing out.
    const size = (name: 'clientWidth' | 'clientHeight') =>
      vi.spyOn(HTMLElement.prototype, name, 'get').mockReturnValue(400);
    size('clientWidth');
    size('clientHeight');
    renderApp(Places, { id: 'places' });

    const pins = await screen.findAllByTestId('places-pin-place');
    expect(pins.map((pin) => pin.getAttribute('aria-label'))).toEqual(['Home']);
  });

  it('still sets one for a place whose position reads', async () => {
    await openList();

    const home = screen.getByRole('button', { name: 'Set waypoint to Home' });
    expect((home as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.click(home);
    expect(fixture.setWaypoint).toHaveBeenCalledWith(215.3, -810.6);
  });
});
