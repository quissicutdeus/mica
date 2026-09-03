// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../../../web/src/host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { fakeTransport } from '../__fixtures__/fakeTransport';
import type { ToShell } from '../messages';
import { setConstants } from '../constants';
import { hydrateStorage } from '../storageCache';

// MICA-16 step 4: the seam test for the shell facets and the special cases — key-set
// parity with each inProcess twin (as Task 4's dataFacets.test.ts), plus the handful of
// behavioral cases the brief calls out by name. Mocked so importing the inProcess twins
// (which pull in `shell/state/*`) never touches a real transport or network.
vi.mock('../../../../web/src/nui/fetchNui', () => ({ fetchNui: vi.fn() }));
vi.mock('../../../../web/src/services/notifications', () => ({ addNotificationItem: vi.fn() }));

import { appAction as inAppAction } from '../../../../web/src/host/facets/appAction';
import { appEvents as inAppEvents } from '../../../../web/src/host/facets/appEvents';
import { appRegistry as inAppRegistry } from '../../../../web/src/host/facets/appRegistry';
import { appRegistryWrite as inAppRegistryWrite } from '../../../../web/src/host/facets/appRegistryWrite';
import { clock as inClock } from '../../../../web/src/host/facets/clock';
import { clockWrite as inClockWrite } from '../../../../web/src/host/facets/clockWrite';
import { devTools as inDevTools } from '../../../../web/src/host/facets/devTools';
import { display as inDisplay } from '../../../../web/src/host/facets/display';
import { displayWrite as inDisplayWrite } from '../../../../web/src/host/facets/displayWrite';
import { keybinds as inKeybinds } from '../../../../web/src/host/facets/keybinds';
import { keybindsWrite as inKeybindsWrite } from '../../../../web/src/host/facets/keybindsWrite';
import { navigation as inNavigation } from '../../../../web/src/host/facets/navigation';
import { lifecycle as inLifecycle } from '../../../../web/src/host/facets/lifecycle';
import { notificationSettings as inNotificationSettings } from '../../../../web/src/host/facets/notificationSettings';
import { notificationSettingsWrite as inNotificationSettingsWrite } from '../../../../web/src/host/facets/notificationSettingsWrite';
import { phoneNotification as inPhoneNotification } from '../../../../web/src/host/facets/phoneNotification';
import { sound as inSound } from '../../../../web/src/host/facets/sound';
import { systemHardware as inSystemHardware } from '../../../../web/src/host/facets/systemHardware';
import { systemHardwareWrite as inSystemHardwareWrite } from '../../../../web/src/host/facets/systemHardwareWrite';
import { theme as inTheme } from '../../../../web/src/host/facets/theme';
import { themeWrite as inThemeWrite } from '../../../../web/src/host/facets/themeWrite';
import { wallpaper as inWallpaper } from '../../../../web/src/host/facets/wallpaper';
import { wallpaperWrite as inWallpaperWrite } from '../../../../web/src/host/facets/wallpaperWrite';
import { storage as inStorage } from '../../../../web/src/host/facets/storage';

import { appAction } from './appAction';
import { appEvents } from './appEvents';
import { appLevels, type AppLevelsConfig } from './appLevels';
import { appRegistry } from './appRegistry';
import { appRegistryWrite } from './appRegistryWrite';
import { clock } from './clock';
import { clockWrite } from './clockWrite';
import { devTools } from './devTools';
import { display } from './display';
import { displayWrite } from './displayWrite';
import { keybinds } from './keybinds';
import { keybindsWrite } from './keybindsWrite';
import { navigation } from './navigation';
import { notificationSettings } from './notificationSettings';
import { notificationSettingsWrite } from './notificationSettingsWrite';
import { phoneNotification } from './phoneNotification';
import { sound } from './sound';
import { systemHardware } from './systemHardware';
import { systemHardwareWrite } from './systemHardwareWrite';
import { theme } from './theme';
import { themeWrite } from './themeWrite';
import { wallpaper } from './wallpaper';
import { wallpaperWrite } from './wallpaperWrite';
import { storage, clearAppStorage } from './storage';
import { persisted } from './persisted';
import { timer } from './timer';
import { onAppForeground, lifecycle } from './lifecycle';

/** A namespaced storage key. Built, not quoted: a `gos:` literal reads as a net event to `server/__tests__/eventNames.test.ts`. */
const storageKey = (app: string, key: string) => `gos:${app}:${key}`;

const keys = (o: object) => Object.keys(o).sort();

const fakeConstants = {
  display: {
    displaySizeDefault: 50,
    homeGridColumnsDefault: 4,
    homeGridColumnsMin: 3,
    homeGridColumnsMax: 5,
    homeGridRowsDefault: 5,
    homeGridRowsMin: 4,
    homeGridRowsMax: 6
  },
  wallpaper: { presets: [], defaultWallpaper: { type: 'color' } },
  systemHardware: { volumeStepChoices: [1, 2, 5, 10, 20] },
  theme: { defaultTheme: { seed: '#155dfc', mode: 'dark' } },
  clock: { is24Hour: false }
};

beforeEach(() => {
  fakeTransport();
  setConstants(fakeConstants);
});

describe('iframe shell facet twins — key parity with inProcess', () => {
  it.each([
    ['appRegistry', appRegistry, inAppRegistry],
    ['appRegistryWrite', appRegistryWrite, inAppRegistryWrite],
    ['clock', clock, inClock],
    ['clockWrite', clockWrite, inClockWrite],
    ['devTools', devTools, inDevTools],
    ['display', display, inDisplay],
    ['displayWrite', displayWrite, inDisplayWrite],
    ['keybinds', keybinds, inKeybinds],
    ['keybindsWrite', keybindsWrite, inKeybindsWrite],
    ['navigation', navigation, inNavigation],
    ['notificationSettings', notificationSettings, inNotificationSettings],
    ['notificationSettingsWrite', notificationSettingsWrite, inNotificationSettingsWrite],
    ['phoneNotification', phoneNotification, inPhoneNotification],
    ['sound', sound, inSound],
    ['systemHardware', systemHardware, inSystemHardware],
    ['systemHardwareWrite', systemHardwareWrite, inSystemHardwareWrite],
    ['theme', theme, inTheme],
    ['themeWrite', themeWrite, inThemeWrite],
    ['wallpaper', wallpaper, inWallpaper],
    ['wallpaperWrite', wallpaperWrite, inWallpaperWrite]
  ] as const)('%s: same keys as inProcess', (_name, iframeFacet, inProcessFacet) => {
    expect(keys(iframeFacet())).toEqual(keys(inProcessFacet()));
  });

  it('appAction(appId): same keys as inProcess', () => {
    expect(keys(appAction('blabber'))).toEqual(keys(inAppAction('blabber')));
  });

  it('appEvents(appId): same keys as inProcess', () => {
    expect(keys(appEvents('blabber'))).toEqual(keys(inAppEvents('blabber')));
  });

  it('storage(appId): same keys as inProcess', () => {
    expect(keys(storage('blabber'))).toEqual(keys(inStorage('blabber')));
  });

  it('lifecycle(appId): same keys as inProcess', () => {
    expect(keys(lifecycle('blabber'))).toEqual(keys(inLifecycle('blabber')));
  });
});

describe('appLevels — the back handler special case', () => {
  const config = (): AppLevelsConfig => ({
    appId: 'notes',
    title: 'Notes',
    levels: [
      { open: vi.fn(() => true), close: vi.fn(), title: 'Detail' },
      { open: vi.fn(() => false), close: vi.fn() }
    ]
  });

  /** MICA-27: routed through the `lifecycle` facet, not a raw `keybinds` call. */
  it('registers back via lifecycle.onBack with a callback ref', () => {
    const f = fakeTransport();
    setConstants(fakeConstants);
    appLevels(config());

    const msg = f.sent.find(
      (m) => m.kind === 'call' && m.facet === 'lifecycle' && m.member === 'onBack'
    ) as Extract<ToShell, { kind: 'call' }>;
    expect(msg).toBeDefined();
    // Ownership comes entirely from the pinned factory arg now, not a call argument a
    // frame could otherwise lie about — see `IframeHostServer.ts`'s `APP_SCOPED_FACETS`.
    expect(msg.factoryArgs).toEqual(['notes']);
    expect(msg.args[0]).toMatchObject({ __cb: expect.any(Number) });
  });

  it('back() closes the deepest open level', () => {
    const c = config();
    const twin = appLevels(c);
    twin.back();
    expect(c.levels[0].close).toHaveBeenCalledTimes(1);
    expect(c.levels[1].close).not.toHaveBeenCalled();
  });
});

describe('storage — cache-backed reads', () => {
  it('getItem is sync from hydrateStorage', () => {
    hydrateStorage({ [storageKey('blabber', 'k')]: '"v"' });
    expect(storage('blabber').getItem('k')).toBe('v');
  });
});

describe('clearAppStorage — routes through the storage facet, not a bare facet name', () => {
  it('sends a call to storage.clear scoped by appId, and clears the local cache', () => {
    const f = fakeTransport();
    hydrateStorage({ [storageKey('probe', 'k')]: '"v"' });
    expect(storage('probe').getItem('k')).toBe('v');

    clearAppStorage('probe');

    const msg = f.sent.find(
      (m) => m.kind === 'call' && m.facet === 'storage' && m.member === 'clear'
    ) as Extract<ToShell, { kind: 'call' }>;
    expect(msg).toBeDefined();
    expect(msg.factoryArgs).toEqual(['probe']);

    expect(storage('probe').getItem('k')).toBeNull();
  });
});

describe('persisted — initial value from the cache', () => {
  it('reads its starting value from whatever hydrateStorage already put in the cache', () => {
    hydrateStorage({ [storageKey('blabber', 'pref')]: '"fromCache"' });
    const store = persisted('blabber', 'pref', 'default');
    expect(get(store)).toBe('fromCache');
  });
});

describe('timer — verbatim from inProcess', () => {
  it('after/every/clearAll all exist', () => {
    const t = timer();
    expect(keys(t)).toEqual(['after', 'clearAll', 'every']);
  });
});

describe('onAppForeground — transition-only, over the lifecycle twin store', () => {
  it('fires once on a push into foreground and not on a repeat push', () => {
    const f = fakeTransport();
    const handler = vi.fn();
    onAppForeground('probe', handler);

    const sub = f.sent.find(
      (m) => m.kind === 'subscribe' && m.facet === 'lifecycle' && m.member === 'currentApp'
    ) as Extract<ToShell, { kind: 'subscribe' }>;
    expect(sub).toBeDefined();
    const push = f.pushes.get(sub.id)!;

    push({ id: 'probe', props: {} });
    expect(handler).toHaveBeenCalledTimes(1);

    push({ id: 'probe', props: {} });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
