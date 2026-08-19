import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import Dock from './Dock.svelte';
import { dockAppIds, DEFAULT_DOCK_APP_IDS } from './state/dock';
import { appDrawerHintSeen } from './state/onboarding';

if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  }) as unknown as Element['animate'];
}

beforeEach(() => {
  dockAppIds.set([...DEFAULT_DOCK_APP_IDS]);
  appDrawerHintSeen.set(false);
});

describe('Dock', () => {
  it('renders exactly 4 slots', () => {
    const { container } = render(Dock, { props: { openApp: () => {} } });
    expect(container.querySelectorAll('[data-dock-index]')).toHaveLength(4);
  });

  it('tapping a configured slot opens that app', async () => {
    const openApp = vi.fn();
    const { getByText } = render(Dock, { props: { openApp } });
    await fireEvent.click(getByText('Phone'));
    expect(openApp).toHaveBeenCalledWith('phone');
  });

  it('renders a placeholder for an unconfigured slot rather than crashing', () => {
    dockAppIds.set(['phone', '', '', '']);
    const { container } = render(Dock, { props: { openApp: () => {} } });
    expect(container.querySelectorAll('[data-dock-index]')).toHaveLength(4);
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('renders a placeholder for an id with no resolvable manifest', () => {
    dockAppIds.set(['not_a_real_app', 'messages', 'media', 'camera']);
    const { container } = render(Dock, { props: { openApp: () => {} } });
    expect(container.querySelectorAll('button')).toHaveLength(3);
  });

  it('shows the swipe-up hint until the drawer has been opened once', async () => {
    const { getByText, queryByText } = render(Dock, { props: { openApp: () => {} } });
    expect(getByText('Swipe up for apps')).toBeTruthy();

    appDrawerHintSeen.set(true);
    await Promise.resolve();
    expect(queryByText('Swipe up for apps')).toBeNull();
  });

  it('hides the hint immediately when already seen', () => {
    appDrawerHintSeen.set(true);
    const { queryByText } = render(Dock, { props: { openApp: () => {} } });
    expect(queryByText('Swipe up for apps')).toBeNull();
  });
});
