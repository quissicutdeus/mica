// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/** In-process facets: a unit test stands in for the shell (MICA-176). */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import { __reloadPausedWidgetsForTest, pausedWidgets, resumeWidget } from './widgetPause';
import AddOnWidgetFrame from './AddOnWidgetFrame.svelte';
import { appRegistryStore } from '../state/registry';
import { resetHostsForTest } from '../../../../sdk/host/current';
import { hostForApp } from '../../../../sdk/host/inProcess/createInProcessHost';
import { defineApp, type AppManifest, type AppManifestInput } from '../../../../sdk/manifest';
import '../../../../sdk/host/useDisplay';
import '../../../../sdk/host/useWallpaper';
import '../../../../sdk/host/useSystemHardware';
import '../../../../sdk/host/useTheme';

/**
 * MICA-245. jsdom never runs a `srcdoc`, so what this covers is what the component owns:
 * whether a frame is booted at all, that it is the app frame's sandbox with input taken
 * away, and that the server behind it hydrates in widget mode under the app's own host.
 * `bootWidget.test.ts` covers the other side of the wall; `IframeHostServer.test.ts`
 * compares the widget server's answers with the app frame's.
 */

const base: AppManifestInput = {
  id: 'probe',
  name: 'Probe',
  icon: 'x',
  tile: { bg: 'bg-gray-900' },
  core: false,
  permissions: ['contacts']
};

const built = vi.hoisted(() => ({ opts: [] as unknown[] }));

vi.mock('./IframeHostServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./IframeHostServer')>();
  return {
    ...actual,
    createIframeHostServer: (opts: Parameters<typeof actual.createIframeHostServer>[0]) => {
      built.opts.push(opts);
      return actual.createIframeHostServer(opts);
    }
  };
});

type ServerOpts = Parameters<typeof import('./IframeHostServer').createIframeHostServer>[0];
const lastOpts = () => built.opts[built.opts.length - 1] as ServerOpts;

let manifest: AppManifest | undefined;
let installed = true;

beforeEach(() => {
  resetHostsForTest();
  built.opts.length = 0;
  manifest = defineApp({ ...base, widget: { sizes: ['2x1'] } });
  installed = true;
  vi.spyOn(appRegistryStore, 'getAddOnSource').mockResolvedValue('x');
  vi.spyOn(appRegistryStore, 'getManifest').mockImplementation(() => manifest);
  vi.spyOn(appRegistryStore, 'isInstalled').mockImplementation(() => installed);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const frameIn = (container: HTMLElement) =>
  container.querySelector<HTMLIFrameElement>('iframe[data-widget="probe"]');

const waitForFrame = (container: HTMLElement) =>
  waitFor(() => {
    const el = frameIn(container);
    if (!el) throw new Error('not yet rendered');
    return el;
  });

/** Lets the source promise settle, so "no frame" means "never", not "not yet". */
const settle = async () => {
  await Promise.resolve();
  await tick();
  await tick();
};

describe('AddOnWidgetFrame', () => {
  it('boots the app frame’s sandbox, with input taken away and nothing painted behind it', async () => {
    const { container } = render(AddOnWidgetFrame, { props: { appId: 'probe', size: '2x1' } });
    const iframe = await waitForFrame(container);

    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(iframe.hasAttribute('inert')).toBe(true);
    expect(iframe.getAttribute('tabindex')).toBe('-1');
    expect(iframe.className).toContain('pointer-events-none');
    expect(iframe.className).toContain('bg-transparent');
    expect(iframe.dataset.size).toBe('2x1');
  });

  it('hydrates in widget mode with its size, under the host the app frame uses', async () => {
    const { container } = render(AddOnWidgetFrame, { props: { appId: 'probe', size: '2x1' } });
    const iframe = await waitForFrame(container);
    const reloaded = { postMessage: vi.fn() };
    Object.defineProperty(iframe, 'contentWindow', { value: reloaded, configurable: true });

    await fireEvent(
      window,
      new MessageEvent('message', {
        data: { kind: 'hello', appId: 'probe' },
        source: reloaded as unknown as Window,
        origin: 'null'
      })
    );

    await waitFor(() =>
      expect(reloaded.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'hydrate',
          payload: expect.objectContaining({ mode: 'widget', props: { size: '2x1' } })
        }),
        expect.anything()
      )
    );
    // The host `Shell` hands `AddOnFrame` for this app, not a second one built for the
    // widget: one set of declared permissions per app, whichever surface asks.
    expect(lastOpts().host).toBe(hostForApp('probe', manifest));
    expect(lastOpts().manifest).toBe(manifest);
    expect(lastOpts().mode).toBe('widget');
  });

  it('boots nothing for an app with no widget, a size it does not offer, or a core app', async () => {
    for (const [m, size] of [
      [defineApp(base), '2x1'],
      [defineApp({ ...base, widget: { sizes: ['2x1'] } }), '2x2'],
      [defineApp({ ...base, core: true, widget: { sizes: ['2x1'] } }), '2x1']
    ] as const) {
      manifest = m;
      const { container, unmount } = render(AddOnWidgetFrame, { props: { appId: 'probe', size } });
      await settle();
      expect(frameIn(container)).toBeNull();
      unmount();
    }
  });

  it('boots nothing for an add-on that is not installed', async () => {
    installed = false;
    const { container } = render(AddOnWidgetFrame, { props: { appId: 'probe', size: '2x1' } });
    await settle();
    expect(frameIn(container)).toBeNull();
  });

  it('pushes a resize into the running widget rather than rebuilding it', async () => {
    manifest = defineApp({ ...base, widget: { sizes: ['2x1', '2x2'] } });
    const { container, rerender } = render(AddOnWidgetFrame, {
      props: { appId: 'probe', size: '2x1' }
    });
    const iframe = await waitForFrame(container);
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');

    await rerender({ appId: 'probe', size: '2x2' });

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        { kind: 'props', props: { size: '2x2' } },
        expect.anything()
      )
    );
    expect(frameIn(container)).toBe(iframe);
  });

  it('goes blank, with no crash sheet, when the widget errors or navigates away', async () => {
    const { container, queryByText } = render(AddOnWidgetFrame, {
      props: { appId: 'probe', size: '2x1' }
    });
    const iframe = await waitForFrame(container);
    await fireEvent(
      window,
      new MessageEvent('message', {
        data: { kind: 'error', message: 'boom', stack: null },
        source: iframe.contentWindow as unknown as Window,
        origin: 'null'
      })
    );
    await waitFor(() => expect(frameIn(container)).toBeNull());
    expect(queryByText('App Stopped Working')).toBeNull();

    const second = render(AddOnWidgetFrame, { props: { appId: 'probe', size: '2x1' } });
    const other = await waitForFrame(second.container);
    await fireEvent.load(other);
    await fireEvent.load(other);
    await waitFor(() => expect(frameIn(second.container)).toBeNull());
  });
});

/**
 * MICA-245: the crash-loop breaker. A widget that hangs the thread never gets to clear its
 * marker, so "the marker survived to the next load" is what a hang looks like here — a
 * test cannot freeze jsdom, but it can leave the `ready` unsent and reload.
 */
describe('AddOnWidgetFrame crash-loop breaker', () => {
  const MARKER = 'mica_widget_booting';
  const marked = () => JSON.parse(localStorage.getItem(MARKER) ?? '[]') as string[];

  // This suite's jsdom has no real `localStorage` (see `sdk/storage.test.ts`), so a
  // Map-backed one stands in — the breaker's own try/catch would otherwise fail open and
  // every assertion below would pass for the wrong reason or fail for one.
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      }
    });
    __reloadPausedWidgetsForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __reloadPausedWidgetsForTest();
  });

  const ready = (iframe: HTMLIFrameElement) =>
    fireEvent(
      window,
      new MessageEvent('message', {
        data: { kind: 'ready' },
        source: iframe.contentWindow as unknown as Window,
        origin: 'null'
      })
    );

  it('marks the widget booting, and clears the mark once it reports ready', async () => {
    const { container } = render(AddOnWidgetFrame, { props: { appId: 'probe', size: '2x1' } });
    const iframe = await waitForFrame(container);
    expect(marked()).toEqual(['probe']);

    await ready(iframe);
    expect(marked()).toEqual([]);
    expect(get(pausedWidgets).has('probe')).toBe(false);
  });

  it('clears the mark when the frame is torn down in order before it was ready', async () => {
    const { container, unmount } = render(AddOnWidgetFrame, {
      props: { appId: 'probe', size: '2x1' }
    });
    await waitForFrame(container);
    unmount();
    expect(marked()).toEqual([]);
  });

  it('pauses a widget whose mark survived a reload, and boots it again once resumed', async () => {
    // Left mid-boot with no `ready` and no teardown — what a frozen thread leaves behind.
    localStorage.setItem(MARKER, JSON.stringify(['probe']));
    __reloadPausedWidgetsForTest();
    expect(get(pausedWidgets).has('probe')).toBe(true);

    const { container } = render(AddOnWidgetFrame, { props: { appId: 'probe', size: '2x1' } });
    await settle();
    expect(frameIn(container)).toBeNull();
    // Still paused on the load after that, too: nothing booted, so nothing settled.
    __reloadPausedWidgetsForTest();
    expect(get(pausedWidgets).has('probe')).toBe(true);

    resumeWidget('probe');
    expect(marked()).toEqual([]);
    await waitForFrame(container);
  });

  it('settles rather than pauses a widget that crashed', async () => {
    const { container } = render(AddOnWidgetFrame, { props: { appId: 'probe', size: '2x1' } });
    const iframe = await waitForFrame(container);
    await fireEvent(
      window,
      new MessageEvent('message', {
        data: { kind: 'error', message: 'boom', stack: null },
        source: iframe.contentWindow as unknown as Window,
        origin: 'null'
      })
    );
    expect(marked()).toEqual([]);
    __reloadPausedWidgetsForTest();
    expect(get(pausedWidgets).has('probe')).toBe(false);
  });
});
