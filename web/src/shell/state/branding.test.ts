// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../host/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { OwnerConfig } from '@mica/shared/ownerConfig';
import { themeStore, setThemeSeed, setThemeMode, resetTheme } from './theme';
import { ownerConfig } from './ownerConfig';
import { activeFrame, activeFrameColor, frameSetting, frameColorSetting } from './phoneFrame';
import { DEFAULT_SEED } from '../../../../sdk/host/seam/theme';
import { safeWallpaperUrls } from '../../apps/settings/ownerWallpapers';

const owner = (over: Partial<OwnerConfig> = {}) =>
  ownerConfig.set({
    disabledApps: [],
    defaultDock: [],
    themeSeed: null,
    defaultFrame: 'classic',
    wallpapers: [],
    brandLogo: null,
    ...over
  });

describe('owner branding (MICA-236)', () => {
  beforeEach(() => {
    resetTheme();
    frameSetting.set('');
    frameColorSetting.set('');
    owner();
  });

  it("the owner's seed is the default for a player who never chose", () => {
    owner({ themeSeed: '#0e9f6e' });
    expect(get(themeStore).seed).toBe('#0e9f6e');
  });

  it('a mode change is not choosing a seed', () => {
    owner({ themeSeed: '#0e9f6e' });
    setThemeMode('light');
    expect(get(themeStore)).toMatchObject({ seed: '#0e9f6e', mode: 'light' });
  });

  it("the player's own pick wins, and survives an owner change", () => {
    owner({ themeSeed: '#0e9f6e' });
    setThemeSeed('#ea580c');
    expect(get(themeStore).seed).toBe('#ea580c');
    owner({ themeSeed: '#7c3aed' });
    expect(get(themeStore).seed).toBe('#ea580c');
  });

  it('choosing the shipped seed is a choice too', () => {
    owner({ themeSeed: '#0e9f6e' });
    setThemeSeed(DEFAULT_SEED);
    owner({ themeSeed: '#7c3aed' });
    expect(get(themeStore).seed).toBe(DEFAULT_SEED);
  });

  it('reset follows the owner again', () => {
    setThemeSeed('#ea580c');
    resetTheme();
    owner({ themeSeed: '#0e9f6e' });
    expect(get(themeStore).seed).toBe('#0e9f6e');
  });

  it("the frame defaults to the owner's, and the player's choice wins", () => {
    expect(get(activeFrame)).toBe('classic');
    owner({ defaultFrame: 'notch' });
    expect(get(activeFrame)).toBe('notch');
    frameSetting.set('punch');
    owner({ defaultFrame: 'classic' });
    expect(get(activeFrame)).toBe('punch');
    frameSetting.set('nonsense');
    expect(get(activeFrame)).toBe('classic');
  });

  it('the frame colour is black until chosen', () => {
    expect(get(activeFrameColor)).toBe('black');
    frameColorSetting.set('silver');
    expect(get(activeFrameColor)).toBe('silver');
  });

  it('lists only wallpaper URLs that cannot break out of url()', () => {
    expect(
      safeWallpaperUrls([
        'https://cfx-nui-mica/branding/wallpapers/a.png',
        '/mock-branding/aurora.svg',
        "https://cfx-nui-mica/x');background:red",
        'javascript:alert(1)',
        5
      ])
    ).toEqual(['https://cfx-nui-mica/branding/wallpapers/a.png', '/mock-branding/aurora.svg']);
  });
});
