// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import AddOnFrame from './AddOnFrame.svelte';
import { appRegistryStore } from '../state/registry';
import { createInProcessHost } from '../../sdk/host/inProcess/createInProcessHost';
import { defineApp, type AppManifest } from '../../sdk/manifest';

/**
 * jsdom does not execute an iframe's `srcdoc`, so nothing inside the frame ever really
 * runs — there is no add-on to say 'hello'. What this covers instead is the wiring
 * `AddOnFrame` owns itself: it renders the sandboxed frame once the source has arrived,
 * turns an `error` message from that frame's `window` into the same crash screen
 * `ErrorBoundary` shows for an in-process app (with a Restart that mounts a fresh
 * iframe), and — Critical 2 fix, review round 1 — does NOT tear down and rebuild the
 * live host server just because a prop object was replaced by a re-render (e.g. the
 * app re-opened with a new `props` value from `openApp`).
 */

const manifest: AppManifest = defineApp({
  id: 'probe',
  name: 'Probe',
  icon: 'x',
  color: '#000',
  core: false,
  permissions: []
});

const constructions = vi.hoisted(() => ({ count: 0 }));

vi.mock('./IframeHostServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./IframeHostServer')>();
  return {
    ...actual,
    createIframeHostServer: (opts: Parameters<typeof actual.createIframeHostServer>[0]) => {
      constructions.count += 1;
      return actual.createIframeHostServer(opts);
    }
  };
});

beforeEach(() => {
  constructions.count = 0;
  vi.spyOn(appRegistryStore, 'getAddOnSource').mockResolvedValue('x');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Waits for the frame's iframe element to exist and returns it. */
const waitForFrame = (container: HTMLElement) =>
  waitFor(() => {
    const el = container.querySelector('iframe[data-app="probe"]');
    if (!el) throw new Error('not yet rendered');
    return el as HTMLIFrameElement;
  });

describe('AddOnFrame', () => {
  it('renders a sandboxed iframe once the add-on source has arrived', async () => {
    const { container } = render(AddOnFrame, {
      props: {
        appId: 'probe',
        manifest,
        host: createInProcessHost('probe', []),
        props: {},
        onKey: vi.fn(),
        onTyping: vi.fn()
      }
    });

    const iframe = await waitForFrame(container);

    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('srcdoc')).toBeTruthy();
  });

  it('shows the crash screen when the frame reports an error, and Restart mounts a fresh iframe', async () => {
    const { container, getByText } = render(AddOnFrame, {
      props: {
        appId: 'probe',
        manifest,
        host: createInProcessHost('probe', []),
        props: {},
        onKey: vi.fn(),
        onTyping: vi.fn()
      }
    });

    const firstFrame = await waitForFrame(container);
    const source = firstFrame.contentWindow;
    expect(source).toBeTruthy(); // exercised for real, not a stand-in

    await fireEvent(
      window,
      new MessageEvent('message', {
        data: { kind: 'error', message: 'boom', stack: null },
        source: source as unknown as Window
      })
    );

    await waitFor(() => expect(getByText('App Stopped Working')).toBeTruthy());
    expect(getByText('Probe')).toBeTruthy();

    await fireEvent.click(getByText('Restart App'));

    const secondFrame = await waitForFrame(container);
    // The `{#key generation}` restart must mount a genuinely new iframe, not just leave
    // the old node in place — a stale node would still be wired to the disposed server.
    expect(secondFrame).not.toBe(firstFrame);
  });

  it('does not tear down and rebuild the host server when `props` is replaced by a re-render', async () => {
    const { container, rerender } = render(AddOnFrame, {
      props: {
        appId: 'probe',
        manifest,
        host: createInProcessHost('probe', []),
        props: { count: 1 },
        onKey: vi.fn(),
        onTyping: vi.fn()
      }
    });

    await waitForFrame(container);
    expect(constructions.count).toBe(1);

    // `openApp` builds a brand-new props object on every open; a resident add-on must
    // not lose its live server (and the iframe must not reload) just because of that.
    await rerender({
      appId: 'probe',
      manifest,
      host: createInProcessHost('probe', []),
      props: { count: 2 },
      onKey: vi.fn(),
      onTyping: vi.fn()
    });

    expect(constructions.count).toBe(1);
  });
});
