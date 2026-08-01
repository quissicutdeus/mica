import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  currentApp,
  runningApps,
  openApp,
  goHome,
  closeApp,
  closeAllApps,
  closePhone,
  consumeAppProps,
  MAX_RESIDENT_APPS
} from './navigation';
import * as fetchNuiModule from '../utils/fetchNui';

const names = () => get(runningApps).map((a) => a.name);

beforeEach(() => closeAllApps());

describe('navigation store', () => {
  it('initializes to home app', () => {
    expect(get(currentApp)).toEqual({ name: 'home', props: {} });
  });

  it('opens an app with lowercased name and optional props', () => {
    openApp('Phone', { tab: 'keypad' });
    expect(get(currentApp)).toEqual({ name: 'phone', props: { tab: 'keypad' } });
  });

  it('navigates home via goHome', () => {
    openApp('settings');
    expect(get(currentApp).name).toBe('settings');
    goHome();
    expect(get(currentApp)).toEqual({ name: 'home', props: {} });
  });

  it('closes phone and navigates home via closePhone', () => {
    const fetchNuiSpy = vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(async () => ({}));
    openApp('mail');
    closePhone();

    expect(fetchNuiSpy).toHaveBeenCalledWith('hideFrame');
    expect(get(currentApp)).toEqual({ name: 'home', props: {} });

    fetchNuiSpy.mockRestore();
  });
});

describe('residency', () => {
  it('keeps earlier apps mounted', () => {
    openApp('notes');
    openApp('mail');
    expect(names()).toEqual(['notes', 'mail']);
  });

  it('going home leaves everything resident', () => {
    openApp('notes');
    goHome();
    expect(names()).toEqual(['notes']);
  });

  it('closing the phone leaves everything resident, like pocketing it', () => {
    const spy = vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(async () => ({}));
    openApp('notes');
    closePhone();
    expect(names()).toEqual(['notes']);
    spy.mockRestore();
  });

  it('treats home as the shell rather than a resident app', () => {
    openApp('home');
    expect(names()).toEqual([]);
    expect(get(currentApp).name).toBe('home');
  });

  it('does not create two entries for one app opened under different casing', () => {
    openApp('Notes');
    openApp('notes');
    expect(names()).toEqual(['notes']);
  });
});

describe('residency cap', () => {
  it('evicts the least recently used', () => {
    for (let i = 0; i < MAX_RESIDENT_APPS + 2; i++) openApp(`app${i}`);

    const resident = names();
    expect(resident).toHaveLength(MAX_RESIDENT_APPS);
    expect(resident).not.toContain('app0');
    expect(resident).not.toContain('app1');
    expect(resident[resident.length - 1]).toBe(`app${MAX_RESIDENT_APPS + 1}`);
  });

  it('re-opening refreshes recency rather than duplicating', () => {
    openApp('a');
    openApp('b');
    openApp('a');
    expect(names()).toEqual(['b', 'a']);
  });

  it('never evicts an app that stays in use', () => {
    openApp('keeper');
    for (let i = 0; i < MAX_RESIDENT_APPS + 3; i++) {
      openApp(`filler${i}`);
      openApp('keeper');
    }
    expect(names()).toContain('keeper');
  });
});

describe('deep-link props', () => {
  it('merges, so a plain launch keeps an earlier deep link', () => {
    openApp('mail', { mailId: 7 });
    openApp('mail');
    expect(get(currentApp).props).toEqual({ mailId: 7 });
  });

  it('lets a newer deep link win', () => {
    openApp('mail', { mailId: 7 });
    openApp('mail', { mailId: 9 });
    expect(get(currentApp).props).toEqual({ mailId: 9 });
  });

  it('consuming clears both copies', () => {
    // Both matter: the component reads `currentApp.props`, while `runningApps` is what
    // survives a trip to another app. Clearing one and not the other would put the deep
    // link back on the next visit.
    openApp('photos', { initialPhotoId: 3 });
    consumeAppProps('photos');

    expect(get(currentApp).props).toEqual({});
    expect(get(runningApps).find((a) => a.name === 'photos')?.props).toEqual({});
  });

  it('consuming leaves other apps alone', () => {
    openApp('mail', { mailId: 7 });
    openApp('photos', { initialPhotoId: 3 });
    consumeAppProps('photos');

    expect(get(runningApps).find((a) => a.name === 'mail')?.props).toEqual({ mailId: 7 });
  });

  it('a consumed deep link does not come back on reopen', () => {
    openApp('photos', { initialPhotoId: 3 });
    consumeAppProps('photos');
    goHome();
    openApp('photos');

    expect(get(currentApp).props).toEqual({});
  });
});

describe('closing an app', () => {
  it('unmounts one and leaves the rest', () => {
    openApp('notes');
    openApp('mail');
    closeApp('notes');
    expect(names()).toEqual(['mail']);
  });

  it('returns home when the closed app was on screen', () => {
    openApp('notes');
    closeApp('notes');
    expect(get(currentApp).name).toBe('home');
  });

  it('stays put when closing a background app', () => {
    openApp('notes');
    openApp('mail');
    closeApp('notes');
    expect(get(currentApp).name).toBe('mail');
  });

  it('clears everything', () => {
    openApp('notes');
    openApp('mail');
    closeAllApps();
    expect(names()).toEqual([]);
    expect(get(currentApp).name).toBe('home');
  });
});
