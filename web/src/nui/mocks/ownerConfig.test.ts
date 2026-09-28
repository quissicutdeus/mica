// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// MICA-234: the mock reads `window.location.search` at module scope, so this needs a real
// `window` — a node-environment run would silently take the env-var branch for every case.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => {
  window.history.pushState({}, '', '/');
  vi.unstubAllEnvs();
});

describe('the shell:ownerConfig mock (MICA-234)', () => {
  it('answers nothing disabled and the built-in dock with no convar configured', async () => {
    const { MockRegistry } = await import('./registry');
    expect(await MockRegistry.handle('shell:ownerConfig')).toMatchObject({
      disabledApps: [],
      defaultDock: []
    });
  });

  it('offers a sample wallpaper and reads the seed and frame from the query (MICA-236)', async () => {
    window.history.pushState({}, '', '/?mica_theme_seed=%230e9f6e&mica_default_frame=notch');
    const { MockRegistry } = await import('./registry');
    expect(await MockRegistry.handle('shell:ownerConfig')).toMatchObject({
      themeSeed: '#0e9f6e',
      defaultFrame: 'notch',
      wallpapers: ['/mock-branding/aurora.svg'],
      brandLogo: null,
      sounds: [{ id: 'owner:Sample-Tone', url: '/mock-branding/sounds/Sample-Tone.wav' }]
    });
  });

  it('answers no owner logo with no query set, the micaOS mark BootScreen falls back to', async () => {
    const { MockRegistry } = await import('./registry');
    expect(await MockRegistry.handle('shell:ownerConfig')).toMatchObject({ brandLogo: null });
  });

  it('reads mica_brand_logo from the query when a spec needs an owner logo fixture', async () => {
    window.history.pushState({}, '', '/?mica_brand_logo=%2Fmock-branding%2Faurora.svg');
    const { MockRegistry } = await import('./registry');
    expect(await MockRegistry.handle('shell:ownerConfig')).toMatchObject({
      brandLogo: '/mock-branding/aurora.svg'
    });
  });

  it('reads mica_disabled_apps and mica_default_dock from the query string', async () => {
    window.history.pushState(
      {},
      '',
      '/?mica_disabled_apps=bank,hodlr&mica_default_dock=notes,,camera,'
    );
    const { MockRegistry } = await import('./registry');

    expect(await MockRegistry.handle('shell:ownerConfig')).toMatchObject({
      disabledApps: ['bank', 'hodlr'],
      defaultDock: ['notes', '', 'camera', '']
    });
  });

  it('falls back to VITE_MICA_DISABLED_APPS / VITE_MICA_DEFAULT_DOCK with no query set', async () => {
    vi.stubEnv('VITE_MICA_DISABLED_APPS', 'marketplace');
    vi.stubEnv('VITE_MICA_DEFAULT_DOCK', 'phone,,,');
    const { MockRegistry } = await import('./registry');

    expect(await MockRegistry.handle('shell:ownerConfig')).toMatchObject({
      disabledApps: ['marketplace'],
      defaultDock: ['phone', '', '', '']
    });
  });

  it('prefers the query string over the env var when both are set', async () => {
    window.history.pushState({}, '', '/?mica_disabled_apps=bank');
    vi.stubEnv('VITE_MICA_DISABLED_APPS', 'marketplace');
    const { MockRegistry } = await import('./registry');

    expect(await MockRegistry.handle('shell:ownerConfig')).toMatchObject({
      disabledApps: ['bank']
    });
  });

  it('appends mica_default_contacts entries to the mock contacts list, past the fixture range', async () => {
    window.history.pushState(
      {},
      '',
      `/?mica_default_contacts=${encodeURIComponent(
        JSON.stringify([{ name: 'Dispatch', number: '911' }])
      )}`
    );
    // Importing the registry is what runs the owner-default-contacts side effect on
    // `./data`'s `mockContacts` — the same module instance `getContacts` answers from.
    await import('./registry');
    const { mockContacts } = await import('./data');

    const seeded = mockContacts.find((c) => c.firstname === 'Dispatch');
    expect(seeded).toMatchObject({ phone: '911', lastname: '' });
    expect(seeded!.id).toBeGreaterThan(9999);
  });

  it('falls back to VITE_MICA_DEFAULT_CONTACTS with no query set', async () => {
    vi.stubEnv(
      'VITE_MICA_DEFAULT_CONTACTS',
      JSON.stringify([{ name: 'Front Desk', number: '555-0000' }])
    );
    await import('./registry');
    const { mockContacts } = await import('./data');

    expect(mockContacts.find((c) => c.firstname === 'Front Desk')).toMatchObject({
      phone: '555-0000'
    });
  });
});
