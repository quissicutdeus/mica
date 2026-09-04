// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * Uninstalling through the Settings pane (MICA-207).
 *
 * `settings.spec.ts` drove this path and passed while an uncaught
 * `Cannot read properties of null (reading 'id')` escaped on every run: `AppInfo`'s handler
 * read `app.id` after awaiting `unregisterApp`, and by then the parent had derived `null`
 * for the app the registry no longer held and unmounted the pane. The uninstall completed;
 * the cleanup after it — forgetting the app's notification policy — never ran.
 *
 * Rendered through a host fixture that derives the prop from a registry store the way the
 * real parent does, because a pane rendered with a fixed prop cannot reproduce the prop
 * going `null` under a running handler.
 *
 * In-process facets, standing in for the shell (MICA-172).
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import { writable } from 'svelte/store';

const seam = vi.hoisted(() => ({
  /** What `unregisterApp` does to the registry — the test wires it to the store it renders. */
  drop: null as null | ((id: string) => void),
  cleared: [] as string[]
}));

vi.mock('@mica/sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAppRegistryWrite: () => ({
    unregisterApp: async (id: string) => {
      seam.drop?.(id);
    }
  }),
  useNotificationSettingsWrite: () => ({
    setAppNotificationPolicy: vi.fn(),
    clearAppNotificationPolicy: (id: string) => seam.cleared.push(id)
  })
}));

import AppInfoHost from './__fixtures__/AppInfoHost.svelte';
import { ArchiveIcon, type AppManifest } from '@mica/sdk';

// jsdom has no Web Animations API and some SDK transitions call it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

const blabber = {
  id: 'blabber',
  name: 'Blabber',
  icon: ArchiveIcon,
  color: 'bg-primary',
  core: false,
  permissions: []
} as unknown as AppManifest;

describe('AppInfo uninstall (MICA-207)', () => {
  it('finishes its cleanup after the registry has dropped the app and the pane is gone', async () => {
    const registry = writable<AppManifest[]>([blabber]);
    seam.drop = (id) => registry.update((apps) => apps.filter((a) => a.id !== id));
    seam.cleared.length = 0;

    const { getByText, getAllByText, queryByText } = render(AppInfoHost, {
      props: { registry, appId: 'blabber' }
    });
    expect(getByText('Store add-on')).toBeTruthy();

    await fireEvent.click(getByText('Uninstall'));
    // The confirm dialog's own button, beneath the pane's.
    const buttons = getAllByText('Uninstall');
    await fireEvent.click(buttons[buttons.length - 1]);

    // The parent derived `null` and unmounted the pane...
    await waitFor(() => expect(queryByText('Store add-on')).toBeNull());
    expect(getByText('no app selected')).toBeTruthy();
    // ...and the handler still reached the cleanup that used to throw first.
    await waitFor(() => expect(seam.cleared).toEqual(['blabber']));
  });
});
