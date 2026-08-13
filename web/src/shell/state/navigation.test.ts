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
import * as fetchNuiModule from '../../nui/fetchNui';

const names = () => get(runningApps).map((a) => a.id);

beforeEach(() => closeAllApps());

describe('navigation store', () => {
  it('initializes to home app', () => {
    expect(get(currentApp)).toEqual({ id: 'home', props: {} });
  });

  it('opens an app with lowercased name and optional props', () => {
    openApp('Phone', { tab: 'keypad' });
    expect(get(currentApp)).toEqual({ id: 'phone', props: { tab: 'keypad' } });
  });

  it('navigates home via goHome', () => {
    openApp('settings');
    expect(get(currentApp).id).toBe('settings');
    goHome();
    expect(get(currentApp)).toEqual({ id: 'home', props: {} });
  });

  it('closes the phone without navigating anywhere', () => {
    // Going home on the way out was visible in game: closing from a photo showed the
    // home screen for a frame before the phone dropped. It also threw away where the
    // player was, so re-opening always landed on home.
    const fetchNuiSpy = vi.spyOn(fetchNuiModule, 'fetchNui').mockImplementation(async () => ({}));
    openApp('mail');
    closePhone();

    expect(fetchNuiSpy).toHaveBeenCalledWith('hideFrame');
    expect(get(currentApp).id).toBe('mail');

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
    // ...and still showing it, so the next open resumes rather than restarts.
    expect(get(currentApp).id).toBe('notes');
    spy.mockRestore();
  });

  it('treats home as the shell rather than a resident app', () => {
    openApp('home');
    expect(names()).toEqual([]);
    expect(get(currentApp).id).toBe('home');
  });

  it('does not create two entries for one app opened under different casing', () => {
    openApp('Notes');
    openApp('notes');
    expect(names()).toEqual(['notes']);
  });
});

describe('residency cap', () => {
  /**
   * Real app ids, not `app0`/`app1`.
   *
   * `openApp` refuses an id with no component behind it, because an unresolvable one used
   * to render a blank screen with no way back. Synthetic ids are exactly what that guard
   * rejects, so the residency cap has to be exercised with apps that actually exist —
   * which is also what it is really about.
   */
  const REAL = ['notes', 'media', 'camera', 'calculator', 'bank', 'store', 'admin'];

  it('evicts the least recently used', () => {
    const opened = REAL.slice(0, MAX_RESIDENT_APPS + 2);
    for (const id of opened) openApp(id);

    const resident = names();
    expect(resident).toHaveLength(MAX_RESIDENT_APPS);
    expect(resident).not.toContain(opened[0]);
    expect(resident).not.toContain(opened[1]);
    expect(resident[resident.length - 1]).toBe(opened[opened.length - 1]);
  });

  it('re-opening refreshes recency rather than duplicating', () => {
    openApp('notes');
    openApp('media');
    openApp('notes');
    expect(names()).toEqual(['media', 'notes']);
  });

  it('never evicts an app that stays in use', () => {
    openApp('notes');
    for (const id of REAL.slice(1)) {
      openApp(id);
      openApp('notes');
    }
    expect(names()).toContain('notes');
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
    openApp('media', { initialPhotoId: 3 });
    consumeAppProps('media');

    expect(get(currentApp).props).toEqual({});
    expect(get(runningApps).find((a) => a.id === 'media')?.props).toEqual({});
  });

  it('consuming leaves other apps alone', () => {
    openApp('mail', { mailId: 7 });
    openApp('media', { initialPhotoId: 3 });
    consumeAppProps('media');

    expect(get(runningApps).find((a) => a.id === 'mail')?.props).toEqual({ mailId: 7 });
  });

  it('a consumed deep link does not come back on reopen', () => {
    openApp('media', { initialPhotoId: 3 });
    consumeAppProps('media');
    goHome();
    openApp('media');

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
    expect(get(currentApp).id).toBe('home');
  });

  it('stays put when closing a background app', () => {
    openApp('notes');
    openApp('mail');
    closeApp('notes');
    expect(get(currentApp).id).toBe('mail');
  });

  it('clears everything', () => {
    openApp('notes');
    openApp('mail');
    closeAllApps();
    expect(names()).toEqual([]);
    expect(get(currentApp).id).toBe('home');
  });
});
