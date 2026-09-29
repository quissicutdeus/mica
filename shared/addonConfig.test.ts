// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  CONVAR_UNSET,
  PUBLIC_ADDON_HOST,
  publicAddonCatalogUrl,
  resolveAddonConfig
} from './addonConfig';

describe('CONVAR_UNSET', () => {
  it('survives being passed to a native as a C string', () => {
    // A NUL anywhere truncates it on the way into GET_CONVAR, and '' resolves to `off`.
    expect(CONVAR_UNSET).toMatch(/^[\x21-\x7e]+$/);
    expect(CONVAR_UNSET.length).toBeGreaterThan(0);
  });

  it('is not a value resolveAddonConfig reads as off or as a URL', () => {
    expect(resolveAddonConfig(CONVAR_UNSET, CONVAR_UNSET, '1').state).toBe('default');
  });
});

describe('resolveAddonConfig', () => {
  it('defaults to the public catalog for the SDK contract, with its host allowed first', () => {
    expect(resolveAddonConfig(CONVAR_UNSET, 'cdn.example.com', '1')).toEqual({
      state: 'default',
      catalogUrl: publicAddonCatalogUrl('1'),
      hosts: [PUBLIC_ADDON_HOST, 'cdn.example.com']
    });
    expect(publicAddonCatalogUrl('1')).toBe('https://mica.gg/addons/sdk-1/catalog.json');
  });

  it('reads off, in any case, and an explicit empty value as off', () => {
    for (const raw of ['off', 'OFF', ' Off ', '', '   ']) {
      expect(resolveAddonConfig(raw, 'store.example.com', '1')).toEqual({
        state: 'off',
        catalogUrl: '',
        hosts: []
      });
    }
  });

  it('uses a custom catalog with exactly the listed hosts', () => {
    expect(
      resolveAddonConfig(' https://store.example.com/c.json ', 'https://store.example.com/x', '1')
    ).toEqual({
      state: 'custom',
      catalogUrl: 'https://store.example.com/c.json',
      hosts: ['store.example.com']
    });
    expect(resolveAddonConfig('https://store.example.com/c.json', CONVAR_UNSET, '1').hosts).toEqual(
      []
    );
  });
});
