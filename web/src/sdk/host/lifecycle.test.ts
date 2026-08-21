// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onAppForeground } from './lifecycle';
import { currentApp, goHome, openApp, closeAllApps } from '../../shell/state/navigation';

// Called outside a component here, so there is no `onDestroy` to hang the teardown on
// and each test releases its own subscription.
const release: Array<() => void> = [];
const watch = (appId: string, handler: () => void) => {
  release.push(onAppForeground(appId, handler));
};

beforeEach(() => {
  release.splice(0).forEach((off) => off());
  closeAllApps();
  currentApp.set({ id: 'home', props: {} });
});

describe('onAppForeground', () => {
  it('fires when the app is already on screen, so a cold open still loads', () => {
    openApp('bank');
    const load = vi.fn();

    watch('bank', load);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('fires again on every return to the front', () => {
    // The gap it exists to close: the app is mounted once and then only hidden, so
    // `onAppMount` runs once per session and Bank showed a balance from whenever it was
    // first opened.
    openApp('bank');
    const load = vi.fn();
    watch('bank', load);

    goHome();
    openApp('bank');
    expect(load).toHaveBeenCalledTimes(2);

    openApp('notes');
    openApp('bank');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('does not fire for other apps', () => {
    const load = vi.fn();
    watch('bank', load);

    openApp('notes');
    openApp('mail');

    expect(load).not.toHaveBeenCalled();
  });

  it('does not re-fire when the same app republishes itself', () => {
    // Consuming a deep link rewrites `currentApp` with the same id. That is not a visit.
    openApp('media', { initialPhotoId: 7 });
    const load = vi.fn();
    watch('media', load);

    openApp('media', { initialPhotoId: 9 });

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('is case-insensitive about the app id, as openApp is', () => {
    const load = vi.fn();
    watch('Bank', load);

    openApp('bank');

    expect(load).toHaveBeenCalledTimes(1);
  });
});
