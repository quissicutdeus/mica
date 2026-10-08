// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseDefaultDock,
  parseDefaultFrame,
  parseDisabledApps,
  parseThemeSeed
} from '@mica/shared/ownerConfig';
import type { ShellCapabilities } from '@mica/shared/types';
import type { MockHandler } from '../registry';
import { ownerConfigRaw } from '../shared';

const mockDisabledApps = parseDisabledApps(
  ownerConfigRaw('mica_disabled_apps', String(import.meta.env.VITE_MICA_DISABLED_APPS ?? ''))
).value;
const mockDefaultDock = parseDefaultDock(
  ownerConfigRaw('mica_default_dock', String(import.meta.env.VITE_MICA_DEFAULT_DOCK ?? ''))
).value;

// MICA-236: branding, by the same two routes. The wallpaper is always offered — it only
// adds a tile to Settings > Display — while a seed and a frame stay unset so an ordinary
// run looks as it always did (`?mica_theme_seed=%230e9f6e&mica_default_frame=notch`).
const mockThemeSeed = parseThemeSeed(
  ownerConfigRaw('mica_theme_seed', String(import.meta.env.VITE_MICA_THEME_SEED ?? ''))
).value;
const mockDefaultFrame = parseDefaultFrame(
  ownerConfigRaw('mica_default_frame', String(import.meta.env.VITE_MICA_DEFAULT_FRAME ?? ''))
).value;

// The owner logo, by the same query route. Unset is null -- the micaOS mark `BootScreen`
// falls back to, matching `parseBrandLogo`'s real-client semantics -- rather than always
// pointing at a fixture file, so an ordinary run boots with the same mark the game shows
// with no owner logo configured. A spec that needs the fixture path asks for it explicitly
// (`?mica_brand_logo=%2Fmock-branding%2Faurora.svg`).
const mockBrandLogo = ownerConfigRaw('mica_brand_logo', '').trim() || null;

/**
 * `?mica_no_money=1` answers `shell:capabilities` the way a standalone server does — no
 * framework, so no money (MICA-169). The default stays fully capable, for the reason
 * documented on the handler; this only lets a spec see the moneyless server.
 */
const mockNoMoney =
  (typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('mica_no_money')) === '1';
/**
 * `?mica_tablet=0` answers the way a server with `mica_tablet` off does (MICA-263): the phone
 * alone. The default lists both, because the browser has a tablet frame to show and the dev
 * launcher describes a server with everything on, for the same reason `money` is `true`.
 */
const mockNoTablet =
  (typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('mica_tablet')) === '0';
const mockCapabilities = (): ShellCapabilities => ({
  money: !mockNoMoney,
  jobs: true,
  devices: mockNoTablet ? ['phone'] : ['phone', 'tablet']
});

export const mocks: Record<string, MockHandler> = {
  /**
   * What a server behind this phone can do (`services/capabilities.ts`).
   *
   * The browser's own mocks answer for money — `getBalance`, `transferMoney` and Hodlr's
   * whole ledger are all here — so the honest answer for this transport is that it has it.
   * Answering `false` would take Bank and Hodlr off the dev launcher and out of every e2e
   * run while the mocks behind them kept working, which describes no real deployment.
   *
   * This is load-bearing rather than decorative: `refreshCapabilities` calls through the
   * transport in a browser too, instead of short-circuiting on `isBrowser()`, so a mock
   * that goes missing here shows up as two apps disappearing rather than as nothing at all.
   */
  'shell:capabilities': () => mockCapabilities(),

  /**
   * The AGPL §13 source address (`services/sourceUrl.ts`). Upstream here, because the mock
   * stands in for a server running an unmodified copy — which is what a browser session is.
   */
  'shell:sourceUrl': () => ({ url: 'https://github.com/quissicutdeus/mica' }),

  /**
   * MICA-243: no image host. The browser mock stores every photo as a `data:` URI, which is
   * what a server without `mica_media_upload_url` does, so the add-on CSP stays as narrow as
   * it was.
   */
  'shell:imageHost': () => ({ origin: null }),
  // MICA-61: no owner default in the browser, so the player's own language decides.
  'shell:locale': () => ({ locale: '' }),
  // MICA-235: a language only the "server" knows, so Settings > Language and the e2e suite
  // can exercise the disk path without a resource on disk.
  'shell:locales': () => ({ languages: ['en', 'fr'] }),
  'shell:catalog': (data: unknown) => {
    const wanted = (data as { locale?: string } | undefined)?.locale;
    return {
      catalogs:
        wanted === 'fr'
          ? {
              shell: { search: 'Rechercher' },
              settings: {
                'language.title': 'Langue',
                'language.subtitle': 'La langue du téléphone',
                'language.section': 'Langue',
                'language.automatic': 'Automatique'
              }
            }
          : {}
    };
  },
  /**
   * `mica_disabled_apps` / `mica_default_dock` (MICA-234), parsed once above so this and
   * the appended `mockContacts` rows read from the same answer.
   */
  'shell:ownerConfig': () => ({
    disabledApps: mockDisabledApps,
    defaultDock: mockDefaultDock,
    themeSeed: mockThemeSeed,
    defaultFrame: mockDefaultFrame,
    wallpapers: ['/mock-branding/aurora.svg'],
    brandLogo: mockBrandLogo,
    sounds: [
      {
        id: 'owner:Sample-Tone',
        label: 'Sample Tone',
        url: '/mock-branding/sounds/Sample-Tone.wav'
      }
    ]
  })
};
