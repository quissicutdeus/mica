// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()`, and do not
// "simplify" this line away by giving that predicate a `typeof` guard — MICA-177 is the
// bug and carries the reasoning, including why both cheap guards are worse than the crash.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../web/src/host/registerFacets';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { ALL_CAPABILITIES, defineApp } from './manifest';
import { MICA_VERSION } from './version';
import { appRegistryStore } from '../web/src/shell/state/registry';
import { currentApp, openApp, goHome } from '../web/src/shell/state/navigation';

/**
 * What `defineApp` lets through.
 *
 * It checked that `id` and `name` were non-empty strings and nothing else, and §4.2 listed
 * three consequences read from the code. These reproduce them first — the id-casing one is
 * the reason this is worth doing at all, because its failure mode is a launcher icon that
 * responds to a tap by rendering nothing at all.
 */

const stub = {} as never;

afterEach(() => {
  goHome();
  vi.restoreAllMocks();
});

describe('defineApp: id casing', () => {
  it('resolves an id with capitals in it, rather than rendering nothing', () => {
    // The original defect: `navigation.ts` lowercases on the way in and `registry.ts` keyed
    // on the raw string, so `openApp('MyApp')` set `currentApp.id` to `myapp` and
    // `getComponent('myapp')` came back undefined. `Shell.svelte` renders nothing at all in
    // that case — no icon, no error, no crash. Silence is the worst available outcome.
    const manifest = defineApp({
      id: 'MyApp',
      name: 'My App',
      color: 'bg-blue-600',
      icon: null,
      // Non-core, or the registry refuses to let the test clean up after itself.
      core: false
    });
    appRegistryStore.registerApp(manifest, stub);

    openApp('MyApp');

    expect(appRegistryStore.getComponent(get(currentApp).id)).toBeDefined();

    appRegistryStore.unregisterApp(manifest.id);
  });

  it('normalizes the id so every downstream key agrees', () => {
    // `id` is the storage namespace, the keybind claim and an event segment. Lowercasing it
    // once here is what keeps those consistent with `openApp`, which lowercases anyway.
    expect(
      defineApp({ id: 'MyApp', name: 'x', color: 'bg-blue-600', icon: null, core: false }).id
    ).toBe('myapp');
  });

  it('warns about it, so the manifest gets fixed rather than silently rewritten', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    defineApp({ id: 'MyApp', name: 'x', color: 'bg-blue-600', icon: null, core: false });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MyApp'));
  });

  it('says nothing about an id that was already lower_snake_case', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    defineApp({ id: 'crypto_tracker', name: 'x', color: 'bg-blue-600', icon: null, core: false });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('defineApp: name', () => {
  it('derives the display name from the id when it is omitted', () => {
    // Every one of the twelve apps in this repo had `name` spelled out and every one of
    // them matched the title-cased id exactly, so the field was pure duplication.
    expect(defineApp({ id: 'notes', color: 'bg-yellow-400', icon: null, core: false }).name).toBe(
      'Notes'
    );
  });

  it('title-cases each word of a snake_case id', () => {
    expect(
      defineApp({ id: 'crypto_tracker', color: 'bg-blue-600', icon: null, core: false }).name
    ).toBe('Crypto Tracker');
  });

  it('keeps an explicit name, for the cases the id cannot express', () => {
    // `GPS` and `My Bank` are not title-cased ids, which is why deriving is a default
    // rather than a rule.
    expect(
      defineApp({ id: 'gps', name: 'GPS', color: 'bg-blue-600', icon: null, core: false }).name
    ).toBe('GPS');
  });

  it('derives rather than trusting an explicit undefined', () => {
    // `{ name: undefined }` spreads as a present key, so a naive default placed before the
    // spread would be clobbered by it and the launcher would render nothing for a label.
    expect(
      defineApp({ id: 'notes', name: undefined, color: 'bg-yellow-400', icon: null, core: false })
        .name
    ).toBe('Notes');
  });

  it('still refuses a name that is present and empty', () => {
    expect(() =>
      defineApp({ id: 'notes', name: '', color: 'bg-yellow-400', icon: null, core: false })
    ).toThrow(/non-empty string/);
  });
});

describe('defineApp: the launcher tile', () => {
  it('throws on a hex value, which would produce an invisible icon', () => {
    // `AppIcon` interpolates the tile straight into a `class` attribute, so `#f59e0b`
    // becomes a class name matching no rule — an icon with no background at all. This was
    // a DEV-only `console.warn` until MICA-91: a warning in a browser console, for a
    // manifest field that is wrong in every environment. One fixture in this repo did it.
    expect(() =>
      defineApp({ id: 'hexy', name: 'Hexy', tile: { bg: '#f59e0b' }, icon: null, core: false })
    ).toThrow("tile.bg '#f59e0b'");
  });

  it('accepts a utility class without complaint', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    defineApp({
      id: 'classy',
      name: 'Classy',
      tile: { bg: 'bg-indigo-600' },
      icon: null,
      core: false
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('registry: duplicate ids', () => {
  it('warns when a second app claims an id that is taken', () => {
    // Two manifests with the same `id` used to mean the second silently replaced the
    // first's component, with both still listed in the launcher.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { tile: { bg: 'bg-blue-600' }, icon: null, core: false } as const;
    const first = defineApp({ id: 'dupe', name: 'First', ...opts });

    appRegistryStore.registerApp(first, stub);
    appRegistryStore.registerApp(defineApp({ id: 'dupe', name: 'Second', ...opts }), stub);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dupe'));
    // Still one entry, not two — the overwrite itself was never the surprising part.
    expect(get(appRegistryStore).filter((a) => a.id === 'dupe')).toHaveLength(1);

    appRegistryStore.unregisterApp('dupe');
  });
});

/**
 * `core` decides whether an app can be uninstalled, and it is the one manifest field with
 * teeth. It replaced `isSystem`, which was defaulted from `author` — so a **display string**
 * decided a protection boundary, and naming your app's author 'gPhone' was enough to make it
 * permanent. These pin down the three ways that went wrong.
 */
describe('defineApp: core', () => {
  it('refuses a manifest that does not declare it', () => {
    // Not defaulted, in either direction. Defaulting to `true` makes every scaffolded app
    // unremovable; defaulting to `false` makes every core app removable the moment somebody
    // forgets the line. The only safe default for a protection boundary is no default.
    expect(() =>
      // @ts-expect-error - the whole point is that the type requires this and the runtime
      // check exists for callers that are not typed, i.e. remote bundles.
      defineApp({ id: 'undeclared', color: 'bg-blue-600', icon: null })
    ).toThrow(/must declare 'core'/);
  });

  it('does not let author decide it', () => {
    // The original defect. 'gPhone' was the derivation's trigger value, so this exact
    // manifest used to come back protected.
    const app = defineApp({
      id: 'authored',
      color: 'bg-blue-600',
      icon: null,
      author: 'gPhone',
      core: false
    });

    expect(app.core).toBe(false);
    expect(app.author).toBe('gPhone');
  });

  it('forces a remote app to be non-core even when it claims otherwise', () => {
    // `core` used to sit *before* the `...manifest` spread, so a downloaded bundle
    // declaring `isSystem: true` survived normalization intact — and `unregisterApp` then
    // refused to remove it, for the rest of the session. Spreading and then normalizing is
    // what closes that; a bundle cannot opt into protection.
    expect(() =>
      defineApp({ id: 'hostile', color: 'bg-blue-600', icon: null, core: true, isRemote: true })
    ).toThrow(/remote app 'hostile' declares 'core: true'/);
  });

  it('lets a remote app omit it entirely, so older bundles still load', () => {
    // A remote app is never core, so requiring the declaration would be ceremony that
    // breaks every bundle written before this field existed.
    const app = defineApp(
      // A remote manifest is untyped by definition — `installVerified` builds it from a
      // `CatalogEntry`, which predates `core`'s existence on some real installs. Cast
      // rather than `@ts-expect-error`, because the assertion under test is a runtime one
      // and the cast is what the real call site effectively does.
      { id: 'legacy_remote', color: 'bg-blue-600', icon: null, isRemote: true } as never
    );

    expect(app.core).toBe(false);
  });
});

describe('defineApp: keybinds', () => {
  it('passes through an optional keybinds array unchanged', () => {
    const manifest = defineApp({
      id: 'snek',
      color: 'bg-green-600',
      icon: null,
      core: false,
      keybinds: [{ id: 'pause', label: 'Pause Game', defaultKey: 'p' }]
    });

    expect(manifest.keybinds).toEqual([{ id: 'pause', label: 'Pause Game', defaultKey: 'p' }]);
  });

  it('leaves keybinds undefined when the manifest declares none', () => {
    const manifest = defineApp({
      id: 'notes',
      color: 'bg-yellow-600',
      icon: null,
      core: false
    });

    expect(manifest.keybinds).toBeUndefined();
  });
});

describe('defineApp: networkHosts', () => {
  it('refuses declared hosts without requiresNetwork: true', () => {
    // The CSP allowlist this becomes (`srcdoc.ts`) is real network egress; declaring
    // hosts while also claiming the app needs no network at all is a contradiction that
    // should fail loudly rather than ship a manifest nobody would have written on purpose.
    expect(() =>
      defineApp({
        id: 'sneaky',
        color: 'bg-blue-600',
        icon: null,
        core: false,
        networkHosts: ['https://api.example.com']
      })
    ).toThrow(/declares 'networkHosts' without 'requiresNetwork: true'/);
  });

  it('refuses a host that is not a bare https origin', () => {
    expect(() =>
      defineApp({
        id: 'malformed',
        color: 'bg-blue-600',
        icon: null,
        core: false,
        requiresNetwork: true,
        networkHosts: ['https://api.example.com/path']
      })
    ).toThrow(/not a bare https origin/);
  });

  it('accepts a well-formed origin alongside requiresNetwork: true', () => {
    const manifest = defineApp({
      id: 'networked',
      color: 'bg-blue-600',
      icon: null,
      core: false,
      requiresNetwork: true,
      networkHosts: ['https://api.example.com', 'https://cdn.example.com:8443']
    });

    expect(manifest.networkHosts).toEqual([
      'https://api.example.com',
      'https://cdn.example.com:8443'
    ]);
  });

  it('lets requiresNetwork: true stand alone with no hosts declared', () => {
    // The common, honest case today: an app needs the in-game cell signal for its own
    // ordinary server-proxied calls, but never calls `fetch()` itself, so there is no
    // host to declare.
    const manifest = defineApp({
      id: 'signal_only',
      color: 'bg-blue-600',
      icon: null,
      core: false,
      requiresNetwork: true
    });

    expect(manifest.networkHosts).toBeUndefined();
  });
});

/**
 * MICA-196. `useService(id)` takes an id the caller chooses, and until this field the
 * only thing deciding whose service an add-on may name was a string prefix over a flat
 * namespace — which cannot separate the app that owns `blabber_dms` from the one whose id
 * prefixes it. The declaration is what makes ownership readable; these checks are what stop
 * it from also making ownership *wider*.
 */
describe('defineApp: services', () => {
  it('keeps a declared service on the way out', () => {
    const manifest = defineApp({
      id: 'blabber',
      color: 'bg-sky-600',
      icon: null,
      core: false,
      services: ['blabber', 'blabber_dms']
    });

    expect(manifest.services).toEqual(['blabber', 'blabber_dms']);
  });

  it('refuses a service outside the app’s own namespace', () => {
    // The point of the field is a claim somebody can check, not a wider claim. An app that
    // could not reach `contacts` before this existed must not reach it by asking.
    expect(() =>
      defineApp({
        id: 'sneaky',
        color: 'bg-blue-600',
        icon: null,
        core: false,
        services: ['contacts']
      })
    ).toThrow(/declares service 'contacts', which is outside its own namespace/);
  });

  it('refuses a near-miss that only looks like the namespace', () => {
    // `blabberx` is not under `blabber_`, and a `startsWith(id)` test would have accepted
    // it. The separator is the namespace.
    expect(() =>
      defineApp({
        id: 'blabber',
        color: 'bg-blue-600',
        icon: null,
        core: false,
        services: ['blabberx']
      })
    ).toThrow(/outside its own namespace/);
  });

  it('refuses a service id that is not lower_snake_case', () => {
    expect(() =>
      defineApp({
        id: 'shouty',
        color: 'bg-blue-600',
        icon: null,
        core: false,
        services: ['Shouty'] as never
      })
    ).toThrow(/not a lower_snake_case id/);
  });

  it('refuses a services field that is not an array', () => {
    expect(() =>
      defineApp({
        id: 'wrong_shape',
        color: 'bg-blue-600',
        icon: null,
        core: false,
        services: 'wrong_shape' as never
      })
    ).toThrow(/has a 'services' that is not an array/);
  });

  it('leaves it absent when nothing is declared, rather than defaulting to a list', () => {
    // Absent and `[]` are different claims. Every add-on published before this field says
    // nothing, and the prefix rule still answers for those — reading absence as "owns no
    // service" would stop each of them calling its own server.
    const manifest = defineApp({
      id: 'legacy_addon',
      color: 'bg-blue-600',
      icon: null,
      core: false
    });

    expect(manifest.services).toBeUndefined();
    expect('services' in manifest).toBe(false);
  });
});

describe('defineApp: devices (MICA-260)', () => {
  const base = { color: 'bg-green-600', icon: null, core: false } as const;

  it('keeps a declared list on the way out, and leaves an add-on that predates it alone', () => {
    expect(defineApp({ id: 'twofer', ...base, devices: ['phone', 'tablet'] }).devices).toEqual([
      'phone',
      'tablet'
    ]);
    const legacy = defineApp({ id: 'phone_only', ...base });
    expect(legacy.devices).toBeUndefined();
    expect('devices' in legacy).toBe(false);
  });

  it('refuses an unknown device, naming the ones that exist', () => {
    expect(() => defineApp({ id: 'typo', ...base, devices: ['watch'] as never })).toThrow(
      /unknown device 'watch'.*Known devices: phone, tablet/
    );
  });

  it('refuses an empty list, which would show the app nowhere', () => {
    expect(() => defineApp({ id: 'nowhere', ...base, devices: [] })).toThrow(
      /'devices: \[\]', which would show it nowhere/
    );
  });

  it('refuses a non-array', () => {
    expect(() => defineApp({ id: 'stringly', ...base, devices: 'tablet' as never })).toThrow(
      /'devices' that is not an array/
    );
  });
});

describe('defineApp: requires', () => {
  it('keeps a declared capability on the way out', () => {
    const manifest = defineApp({
      id: 'moneyed',
      color: 'bg-green-600',
      icon: null,
      core: false,
      requires: ['money']
    });

    expect(manifest.requires).toEqual(['money']);
  });

  it('refuses an unknown capability, naming it', () => {
    // The failure this exists for: an unsatisfiable capability is not a broken app, it is
    // an absent one — hidden on every server rather than only on the ones that lack the
    // thing — and absence reports itself to nobody. `defineApp` is the last place that can
    // say so, and it runs at definition time.
    expect(() =>
      defineApp({
        id: 'typo',
        color: 'bg-green-600',
        icon: null,
        core: false,
        // Not `AppCapability`. A hand-written manifest, or one inside a published JS
        // bundle, is not typechecked against this union at all — which is exactly why the
        // runtime check has to exist alongside the type.
        requires: ['munny'] as never
      })
    ).toThrow(/unknown capability 'munny'/);
  });

  it('names the capabilities that do exist, so the typo is fixable from the message', () => {
    expect(() =>
      defineApp({
        id: 'typo2',
        color: 'bg-green-600',
        icon: null,
        core: false,
        requires: ['inventory'] as never
      })
    ).toThrow(/Known capabilities: money/);
  });

  it('refuses a non-array, rather than iterating a string one character at a time', () => {
    expect(() =>
      defineApp({
        id: 'stringly',
        color: 'bg-green-600',
        icon: null,
        core: false,
        requires: 'money' as never
      })
    ).toThrow(/'requires' that is not an array/);
  });

  it('leaves an add-on that predates the field completely alone', () => {
    // Backward compatibility is the whole reason this is optional. A bundle published
    // before `requires` existed cannot declare it, and the absence has to mean "requires
    // nothing" — not "unknown", and not an empty array every consumer then has to tell
    // apart from undefined.
    const legacy = defineApp({
      id: 'published_last_year',
      color: 'bg-blue-600',
      icon: null,
      core: false
    });

    expect(legacy.requires).toBeUndefined();
    expect('requires' in legacy).toBe(false);
  });

  it('accepts an empty list as the same thing said explicitly', () => {
    expect(
      defineApp({ id: 'explicit', color: 'bg-blue-600', icon: null, core: false, requires: [] })
        .requires
    ).toEqual([]);
  });

  it('survives being re-run over its own output', () => {
    // `shell/state/registry.ts` re-runs `defineApp` over an already-defined manifest to
    // stamp `installedAt`, so every field has to round-trip. `color`/`tile` needed a rule
    // of their own for exactly this reason; `requires` must not grow a second check that
    // fires only on the second pass.
    const once = defineApp({
      id: 'twice',
      color: 'bg-green-600',
      icon: null,
      core: false,
      requires: ['money']
    });

    expect(defineApp(once).requires).toEqual(['money']);
  });
});

describe('ALL_CAPABILITIES', () => {
  it('is non-empty, so the validation above cannot pass vacuously', () => {
    // The `ALL_PERMISSIONS` lesson (`permissions.test.ts`): a vocabulary that failed to
    // import turns a check that looks strict into one that accepts everything.
    expect(ALL_CAPABILITIES.length).toBeGreaterThan(0);
    expect(ALL_CAPABILITIES).toContain('money');
  });
});

describe('defineApp: version', () => {
  afterEach(() => {
    vi.doUnmock('./version');
    vi.resetModules();
  });

  it('defaults to the running build stamp, because a bundled app is this build', () => {
    const manifest = defineApp({
      id: 'stamped',
      tile: { bg: 'bg-indigo-600' },
      icon: null,
      core: false
    });

    // Not pinned to a literal — the stamp is computed from `git log` at build time, so any
    // assertion on its value would fail on the next push. What matters is that the default
    // fired at all, and that it is the same string `MICA_VERSION` reports.
    expect(manifest.version).toBe(MICA_VERSION);
    expect(manifest.version).toBeTruthy();
  });

  it('omits the field entirely when there is no build stamp, rather than setting it empty', async () => {
    // The state an add-on bundle is actually in: `vite.addon.config.ts` defines
    // `__MICA_VERSION__` as `''` on purpose (MICA-170), because a bundle is compiled
    // once and then installed by whatever phone fetches it. So does any third-party bundler
    // that has never heard of the identifier.
    vi.resetModules();
    vi.doMock('./version', () => ({
      MICA_VERSION: '',
      MICA_BUILD_INFO: '',
      SDK_CONTRACT_VERSION: '1'
    }));
    const { defineApp: defineWithoutStamp } = await import('./manifest');

    const manifest = defineWithoutStamp({
      id: 'unstamped',
      tile: { bg: 'bg-indigo-600' },
      icon: null,
      core: false
    });

    // `in`, not `=== undefined`: present-and-undefined would still overwrite a real version
    // wherever a manifest is spread onward, which is the bug this shape exists to avoid.
    expect('version' in manifest).toBe(false);
    expect(manifest.version).toBeUndefined();
  });

  it('lets an author-declared version win over the default either way', async () => {
    expect(
      defineApp({
        id: 'declared',
        tile: { bg: 'bg-indigo-600' },
        icon: null,
        core: false,
        version: '2.3.4'
      }).version
    ).toBe('2.3.4');

    vi.resetModules();
    vi.doMock('./version', () => ({
      MICA_VERSION: '',
      MICA_BUILD_INFO: '',
      SDK_CONTRACT_VERSION: '1'
    }));
    const { defineApp: defineWithoutStamp } = await import('./manifest');

    expect(
      defineWithoutStamp({
        id: 'declared-addon',
        tile: { bg: 'bg-indigo-600' },
        icon: null,
        core: false,
        version: '2.3.4'
      }).version
    ).toBe('2.3.4');
  });
});
