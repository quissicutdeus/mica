import { describe, it, expect, vi, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { defineApp } from './manifest';
import { appRegistryStore } from '../shell/state/registry';
import { currentApp, openApp, goHome } from '../shell/state/navigation';

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

describe('defineApp: color', () => {
  it('warns that a hex string produces an invisible icon', () => {
    // The docstring promised "utility class or hex string" and `AppIcon` interpolates the
    // value straight into a `class` attribute, so `#f59e0b` becomes a class name that
    // matches no rule — an icon with no background at all. One manifest in the repo's own
    // test fixtures does this.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    defineApp({ id: 'hexy', name: 'Hexy', color: '#f59e0b', icon: null, core: false });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('#f59e0b'));
  });

  it('accepts a utility class without complaint', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    defineApp({ id: 'classy', name: 'Classy', color: 'bg-indigo-600', icon: null, core: false });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('registry: duplicate ids', () => {
  it('warns when a second app claims an id that is taken', () => {
    // Two manifests with the same `id` used to mean the second silently replaced the
    // first's component, with both still listed in the launcher.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { color: 'bg-blue-600', icon: null, core: false } as const;
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
      // A remote manifest is untyped by definition — `loadRemoteApp` spreads whatever the
      // bundle exported. Cast rather than `@ts-expect-error`, because the assertion under
      // test is a runtime one and the cast is what the real call site effectively does.
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
