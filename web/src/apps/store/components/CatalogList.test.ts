// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../../host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import { registerMessages, type AppManifest } from '@mica/sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';
import CatalogList from './CatalogList.svelte';

registerMessages('store', { en, de });

const app = (id: string): AppManifest =>
  ({ id, name: id, version: '1.0.0', description: 'd', color: 'bg-indigo-600' }) as AppManifest;

describe('CatalogList (MICA-169)', () => {
  it('shows an unavailable app with its reason and an Install that does nothing', async () => {
    const oninstall = vi.fn();
    render(CatalogList, {
      apps: [app('hodlr'), app('notes')],
      isInstalled: () => false,
      onselect: () => {},
      oninstall,
      onuninstall: () => {},
      unavailable: (a: AppManifest) => (a.id === 'hodlr' ? 'Needs a server with money' : null)
    });
    expect(screen.getByText('Needs a server with money')).toBeTruthy();
    const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Install' });
    expect(buttons.map((b) => b.disabled)).toEqual([true, false]);
    await fireEvent.click(buttons[0]);
    expect(oninstall).not.toHaveBeenCalled();
    await fireEvent.click(buttons[1]);
    expect(oninstall).toHaveBeenCalledTimes(1);
  });
});
