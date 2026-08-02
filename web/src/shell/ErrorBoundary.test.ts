// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import ErrorBoundaryTestWrapper from './__fixtures__/ErrorBoundaryTestWrapper.svelte';
import { currentApp } from './state/navigation';

/**
 * The crash path, which is the only path this component exists for.
 *
 * It was untested, and it did not work: the fallback was an `{#if error}` branch inside
 * the boundary's children, so Svelte destroyed it before the flag was set and a crashed
 * app rendered an empty div. The fixture has had a `shouldCrash` branch the whole time
 * and nothing ever set it to `true`.
 */

beforeEach(() => {
  // The boundary logs every catch. Silence it so a passing run is not full of stacks.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary component', () => {
  it('renders children normally when no error occurs', () => {
    const { getByText } = render(ErrorBoundaryTestWrapper, {
      props: {
        appName: 'TestApp',
        shouldCrash: false
      }
    });

    expect(getByText('Normal Child Content')).toBeTruthy();
  });

  it('shows the fallback instead of a blank screen when a child throws', () => {
    const { getByText, queryByText } = render(ErrorBoundaryTestWrapper, {
      props: { appName: 'TestApp', shouldCrash: true }
    });

    expect(getByText('App Stopped Working')).toBeTruthy();
    expect(queryByText('Normal Child Content')).toBeNull();
  });

  it('names the app that crashed', () => {
    // The manifest's display name, not the registry id — `getManifest(id)?.name` at the
    // call site exists for this, and the message is useless without it.
    const { getByText } = render(ErrorBoundaryTestWrapper, {
      props: { appName: 'Notes', shouldCrash: true }
    });

    expect(getByText('Notes')).toBeTruthy();
  });

  it('offers a way out of the crash', () => {
    const { getByText } = render(ErrorBoundaryTestWrapper, {
      props: { appName: 'TestApp', shouldCrash: true }
    });

    // Both buttons were unreachable before, because the branch holding them never
    // rendered. Their presence is the whole fix.
    expect(getByText('Restart App')).toBeTruthy();
    expect(getByText('Return to Home Screen')).toBeTruthy();
  });

  it('going home from a crash leaves the app', async () => {
    currentApp.set({ id: 'testapp', props: {} });

    const { getByText } = render(ErrorBoundaryTestWrapper, {
      props: { appName: 'TestApp', shouldCrash: true }
    });

    await fireEvent.click(getByText('Return to Home Screen'));

    let landed = '';
    currentApp.subscribe((app) => (landed = app.id))();
    expect(landed).toBe('home');
  });
});
