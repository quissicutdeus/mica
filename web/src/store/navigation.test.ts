import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import { currentApp, openApp, goHome, closePhone } from './navigation';
import * as fetchNuiModule from '../utils/fetchNui';

describe('navigation store', () => {
  it('initializes to home app', () => {
    goHome();
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
