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
      // Non-system, or the registry refuses to let the test clean up after itself.
      isSystem: false
    });
    appRegistryStore.registerApp(manifest, stub);

    openApp('MyApp');

    expect(appRegistryStore.getComponent(get(currentApp).id)).toBeDefined();

    appRegistryStore.unregisterApp(manifest.id);
  });

  it('normalises the id so every downstream key agrees', () => {
    // `id` is the storage namespace, the keybind claim and an event segment. Lowercasing it
    // once here is what keeps those consistent with `openApp`, which lowercases anyway.
    expect(defineApp({ id: 'MyApp', name: 'x', color: 'bg-blue-600', icon: null }).id).toBe(
      'myapp'
    );
  });

  it('warns about it, so the manifest gets fixed rather than silently rewritten', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    defineApp({ id: 'MyApp', name: 'x', color: 'bg-blue-600', icon: null });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MyApp'));
  });

  it('says nothing about an id that was already lower_snake_case', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    defineApp({ id: 'crypto_tracker', name: 'x', color: 'bg-blue-600', icon: null });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('defineApp: name', () => {
  it('derives the display name from the id when it is omitted', () => {
    // Every one of the twelve apps in this repo had `name` spelled out and every one of
    // them matched the title-cased id exactly, so the field was pure duplication.
    expect(defineApp({ id: 'notes', color: 'bg-yellow-400', icon: null }).name).toBe('Notes');
  });

  it('title-cases each word of a snake_case id', () => {
    expect(defineApp({ id: 'crypto_tracker', color: 'bg-blue-600', icon: null }).name).toBe(
      'Crypto Tracker'
    );
  });

  it('keeps an explicit name, for the cases the id cannot express', () => {
    // `GPS` and `My Bank` are not title-cased ids, which is why deriving is a default
    // rather than a rule.
    expect(defineApp({ id: 'gps', name: 'GPS', color: 'bg-blue-600', icon: null }).name).toBe(
      'GPS'
    );
  });

  it('derives rather than trusting an explicit undefined', () => {
    // `{ name: undefined }` spreads as a present key, so a naive default placed before the
    // spread would be clobbered by it and the launcher would render nothing for a label.
    expect(
      defineApp({ id: 'notes', name: undefined, color: 'bg-yellow-400', icon: null }).name
    ).toBe('Notes');
  });

  it('still refuses a name that is present and empty', () => {
    expect(() => defineApp({ id: 'notes', name: '', color: 'bg-yellow-400', icon: null })).toThrow(
      /non-empty string/
    );
  });
});

describe('defineApp: color', () => {
  it('warns that a hex string produces an invisible icon', () => {
    // The docstring promised "Tailwind class or hex string" and `AppIcon` interpolates the
    // value straight into a `class` attribute, so `#f59e0b` becomes a class name that
    // matches no rule — an icon with no background at all. One manifest in the repo's own
    // test fixtures does this.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    defineApp({ id: 'hexy', name: 'Hexy', color: '#f59e0b', icon: null });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('#f59e0b'));
  });

  it('accepts a Tailwind class without complaint', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    defineApp({ id: 'classy', name: 'Classy', color: 'bg-indigo-600', icon: null });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('registry: duplicate ids', () => {
  it('warns when a second app claims an id that is taken', () => {
    // Two manifests with the same `id` used to mean the second silently replaced the
    // first's component, with both still listed in the launcher.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { color: 'bg-blue-600', icon: null, isSystem: false } as const;
    const first = defineApp({ id: 'dupe', name: 'First', ...opts });

    appRegistryStore.registerApp(first, stub);
    appRegistryStore.registerApp(defineApp({ id: 'dupe', name: 'Second', ...opts }), stub);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dupe'));
    // Still one entry, not two — the overwrite itself was never the surprising part.
    expect(get(appRegistryStore).filter((a) => a.id === 'dupe')).toHaveLength(1);

    appRegistryStore.unregisterApp('dupe');
  });
});
