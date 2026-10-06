// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tick } from 'svelte';
import { get, writable } from 'svelte/store';
import {
  ADDON_DEV_ENTRY,
  ADDON_DEV_QUERY,
  MICA_DEV_ADDON_MARKER,
  parseLoopbackBase,
  sameOriginAs,
  type ParsedUrl
} from '@mica/shared/addonDev';
import type { CatalogEntry } from '../../../../sdk/catalog';
import type { HostRuntime } from '@mica/sdk';
import type { AppManifest } from '../state/registry';
import DevAddOnStrip from './DevAddOnStrip.svelte';

/**
 * The phone's half of the add-on dev loop (MICA-311): `?addonDev=<loopback base>` loads an
 * add-on from the author's own machine and mounts it through the ordinary sandboxed path.
 *
 * **Only in a build that allows it.** `Shell.svelte` imports this module behind
 * `import.meta.env.DEV || import.meta.env.VITE_MICA_ADDON_DEV === '1'`, both replaced at
 * build time, so a game build emits no chunk for it. `scripts/check-no-dev-addon.js` reads
 * the emitted files for `MICA_DEV_ADDON_MARKER`, which this module carries at run time (it
 * is the strip's test id), and fails the game build if it finds it. And at run time this
 * still refuses anything but a plain browser tab.
 *
 * **What is waived, and nothing else**: the sha256 compare and the consent sheet. The
 * entry's own `permissions` stand as the grant, in memory only. Registration is
 * `appRegistryStore.registerDevAddOn`, which runs the real `registerAddOn` checks, and the
 * app runs in the ordinary `AddOnFrame` — see that method's doc for the list.
 */

/**
 * Everything this module needs from the shell, **handed in by `Shell.svelte` rather than
 * imported**, and the indirection is load-bearing. Only types are imported from the
 * shell's own graph. A value import of `registry`, `navigation`, `toast` or the shell's
 * `messages` made Rolldown split those modules out of the entry into a chunk shared with
 * this one, and that chunk evaluated in a cycle with the `sdk` chunk before
 * `host/registerFacets` ran: every page load of a DEV build died on `host facet
 * 'persisted' is not loaded` (see the web lane's memory on lazy shell imports). This
 * chunk's own imports are `svelte`, `shared/addonDev` and its strip, and nothing else.
 */
export interface DevAddOnDeps {
  registerDevAddOn: (entry: CatalogEntry, source: string) => AppManifest;
  unregisterDevAddOn: (appId: string) => void;
  isCatalogEntry: (value: unknown) => value is CatalogEntry;
  hostRuntime: () => HostRuntime;
  openApp: (appId: string) => void;
  closeApp: (appId: string) => void;
  /** Raise the failure toast. The shell localizes its title. */
  showError: (message: string) => void;
}

let deps: DevAddOnDeps | null = null;

/** Hand the loader the shell's pieces. `startDevAddOn` does this; a test calls it directly. */
export function setDevAddOnDeps(shell: DevAddOnDeps): void {
  deps = shell;
}

const need = (): DevAddOnDeps => {
  if (!deps) throw new Error('micaOS: the dev add-on loader was used before startDevAddOn.');
  return deps;
};

const messageOf = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : typeof err === 'string' ? err : fallback;

/** Carried at run time, so a build check can find this module in emitted output. */
export const DEV_ADDON_MARKER = MICA_DEV_ADDON_MARKER;

/**
 * Every request this module makes. `redirect: 'error'` because the loopback check judged
 * the URL asked for, and a redirect would land the request somewhere it never judged;
 * `credentials: 'omit'` because nothing on a dev server needs the page's cookies;
 * `no-store` because the bundle changes on every save and a cached copy is the wrong one.
 */
export const DEV_FETCH_INIT: RequestInit = Object.freeze({
  redirect: 'error',
  credentials: 'omit',
  cache: 'no-store'
});

export interface DevAddOnState {
  /** The base URL, as `parseLoopbackBase` serialized it. */
  base: string;
  /** `host:port`, for the strip. */
  source: string;
  /** The registered app, once one is. */
  appId: string | null;
  /** A reload in flight. */
  busy: boolean;
  /** Why the last load or reload failed, or null. */
  error: string | null;
}

/** What the strip draws. Null when no dev add-on was asked for. */
export const devAddOn = writable<DevAddOnState | null>(null);

/** The strip, handed to `Shell.svelte` through the dynamic import so it ships in this chunk only. */
export { DevAddOnStrip };

type Fetched = { ok: true; entry: CatalogEntry; code: string } | { ok: false; reason: string };

/** What the last successful load registered, so a failed reload can put it back. */
let current: { entry: CatalogEntry; code: string } | null = null;

const sourceOf = (base: ParsedUrl): string => new URL(base.href).host;

/** A fetch under `DEV_FETCH_INIT`, with a rejection turned into a reason a person can act on. */
async function fetchDev(
  url: string,
  what: string
): Promise<{ ok: true; response: Response } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetch(url, DEV_FETCH_INIT);
  } catch (err) {
    // A refused redirect and a server that is not running reject identically — the
    // browser does not say which — so the reason names both.
    return {
      ok: false,
      reason:
        `Could not fetch the ${what} from ${url}: ${messageOf(err, 'network error')}. ` +
        `Is the dev server running? A redirect is refused.`
    };
  }
  // Belt and braces: `redirect: 'error'` already rejects above. A response that says it
  // was redirected came from somewhere the loopback check never saw.
  if (response.redirected || response.type === 'opaqueredirect') {
    return { ok: false, reason: `The ${what} at ${url} was redirected, which is refused.` };
  }
  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status} fetching the ${what} from ${url}.` };
  }
  return { ok: true, response };
}

/** Fetch and validate the entry and its bundle. Registers nothing. */
async function fetchDevAddOn(base: ParsedUrl): Promise<Fetched> {
  const entryUrl = new URL(ADDON_DEV_ENTRY, base.href).href;
  const entryRes = await fetchDev(entryUrl, 'catalog entry');
  if (!entryRes.ok) return entryRes;

  let entry: unknown;
  try {
    entry = await entryRes.response.json();
  } catch {
    return { ok: false, reason: `${entryUrl} is not JSON.` };
  }
  if (!need().isCatalogEntry(entry)) {
    return {
      ok: false,
      reason: `${entryUrl} is not a valid catalog entry. Rebuild it with the template's pnpm dev.`
    };
  }
  if (!sameOriginAs(base, entry.bundleUrl)) {
    return {
      ok: false,
      reason: `The entry's bundleUrl '${entry.bundleUrl}' is not on ${base.origin}, which is refused.`
    };
  }

  const bundleUrl = new URL(entry.bundleUrl, base.href).href;
  const bundleRes = await fetchDev(bundleUrl, 'bundle');
  if (!bundleRes.ok) return bundleRes;
  const code = await bundleRes.response.text();
  return { ok: true, entry, code };
}

export type DevLoadResult = { ok: true; appId: string } | { ok: false; reason: string };

/** Register, or undo exactly what was registered. Never leaves a half-registered app. */
function register(entry: CatalogEntry, code: string): DevLoadResult {
  try {
    const manifest = need().registerDevAddOn(entry, code);
    current = { entry, code };
    return { ok: true, appId: manifest.id };
  } catch (err) {
    return { ok: false, reason: messageOf(err, 'the registry refused it') };
  }
}

const outcome = (result: DevLoadResult) =>
  result.ok ? { appId: result.appId, error: null } : { error: result.reason };

/** Refuse unless this is a plain browser tab. A second, run-time half of the build gate. */
function refuseRuntime(): string | null {
  const runtime = need().hostRuntime();
  return runtime === 'browser' ? null : `Dev add-ons load in a browser only, not in '${runtime}'.`;
}

/** Name the failure once: in the console, and as a toast. */
function report(reason: string): void {
  console.error(`[micaOS] ${MICA_DEV_ADDON_MARKER}: ${reason}`);
  need().showError(reason);
}

/**
 * Load the dev add-on at `raw` and open it. Every refusal is returned as a reason, and
 * nothing is registered unless every check passed.
 */
export async function loadDevAddOn(raw: string): Promise<DevLoadResult> {
  const refused = refuseRuntime();
  if (refused) return { ok: false, reason: refused };

  const parsed = parseLoopbackBase(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const { base } = parsed;

  devAddOn.set({
    base: base.href,
    source: sourceOf(base),
    appId: null,
    busy: true,
    error: null
  });

  const fetched = await fetchDevAddOn(base);
  const result = fetched.ok ? register(fetched.entry, fetched.code) : fetched;
  devAddOn.update((s) => s && { ...s, busy: false, ...outcome(result) });
  if (result.ok) need().openApp(result.appId);
  return result;
}

/**
 * Re-fetch from the same base, unregister the running copy, register the new one and
 * reopen it — the strip's Reload. On any failure the running copy is left exactly as it
 * was, and the strip shows why.
 */
export async function reloadDevAddOn(): Promise<DevLoadResult> {
  const state = get(devAddOn);
  if (!state || state.busy) return { ok: false, reason: 'No dev add-on is loaded.' };
  const parsed = parseLoopbackBase(state.base);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  devAddOn.set({ ...state, busy: true, error: null });
  const fetched = await fetchDevAddOn(parsed.base);
  if (!fetched.ok) {
    console.error(`[micaOS] ${MICA_DEV_ADDON_MARKER}: ${fetched.reason}`);
    devAddOn.set({ ...state, busy: false, error: fetched.reason });
    return fetched;
  }

  const previous = current;
  const previousId = state.appId;
  if (previousId) {
    need().closeApp(previousId);
    need().unregisterDevAddOn(previousId);
    // Let the shell render without the app before it comes back. `closeApp` and `openApp`
    // in one tick leave the keyed instance in place, and `AddOnFrame` deliberately never
    // swaps `srcdoc` under a live frame — the author would see the old code and old state.
    // After this flush the old `AddOnFrame` has been destroyed and its host server
    // disposed, so the reopen below mounts a new element with a new server.
    await tick();
  }
  const result = register(fetched.entry, fetched.code);
  if (!result.ok) {
    console.error(`[micaOS] ${MICA_DEV_ADDON_MARKER}: ${result.reason}`);
    // Put back what was running, so a refused reload never leaves nothing behind.
    if (previous) register(previous.entry, previous.code);
    devAddOn.set({ ...state, busy: false, error: result.reason });
    if (previousId && previous) need().openApp(previousId);
    return result;
  }
  devAddOn.set({ ...state, appId: result.appId, busy: false, error: null });
  need().openApp(result.appId);
  return result;
}

/**
 * Boot: read `?addonDev=` once and load it. No parameter, nothing at all happens — no
 * state, no request, nothing registered — which is what makes a reload without it clean.
 */
export async function startDevAddOn(
  shell: DevAddOnDeps,
  search: string = typeof window === 'undefined' ? '' : window.location.search
): Promise<DevLoadResult | null> {
  setDevAddOnDeps(shell);
  const raw = new URLSearchParams(search).get(ADDON_DEV_QUERY);
  if (raw === null) return null;
  const result = await loadDevAddOn(raw);
  if (!result.ok) report(result.reason);
  return result;
}

/** Tests only: forget everything this module holds. */
export function resetDevAddOnForTest(): void {
  const id = get(devAddOn)?.appId;
  if (id) deps?.unregisterDevAddOn(id);
  current = null;
  devAddOn.set(null);
}
