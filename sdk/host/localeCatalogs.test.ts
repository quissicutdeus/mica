// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-235: an owner's `locales/<lang>/<namespace>.json` reaches a sandboxed add-on's
 * frame — its own namespace and `ui`, and never another app's.
 *
 * This file stands in for the **shell** (MICA-176): the in-process facets and the real
 * `IframeHostServer`, answering messages written the way a frame — honest or not — would
 * write them. The frame's half is `iframe/facets/locale.test.ts`, and has to be a separate
 * file: importing the twin registers it as the `locale` facet, and the shell here would
 * then be answering through the frame's own code.
 */
import '../../web/src/host/registerFacets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInProcessHost } from './inProcess/createInProcessHost';
import { resetHostsForTest } from './current';
import { defineApp } from '../manifest';
import { __resetMessages, registerMessages } from '../i18n';
import type { ToFrame, ToShell } from './iframe/messages';
import { createIframeHostServer } from '../../web/src/shell/addon/IframeHostServer';
import { recordConsent, resetGrantsForTest } from '../../web/src/shell/state/addOnGrants';
import { setLocale } from '../../web/src/shell/state/locale';
import { __resetSettingsSync } from '../../web/src/host/settingsSync';

vi.mock('../../web/src/nui/fetchNui', () => ({ fetchNui: vi.fn() }));

const manifest = defineApp({
  id: 'probe',
  name: 'Probe',
  icon: 'x',
  tile: { bg: 'bg-gray-900' },
  core: false,
  permissions: []
});

/** What the shell's registry holds once an owner's disk catalogs have been fetched. */
function registerDisk() {
  registerMessages('probe', {
    en: { hello: 'Hello' },
    de: { hello: 'Hallo' },
    fr: { hello: 'Salut' }
  });
  registerMessages('ui', { de: { cancel: 'Abbrechen' }, fr: { cancel: 'Annuler' } });
  registerMessages('rival', { de: { secret: 'Geheimnis' }, fr: { secret: 'Secret' } });
}

function server() {
  recordConsent('probe', []);
  const posted: ToFrame[] = [];
  const guest = { postMessage: (m: ToFrame) => posted.push(m) };
  const s = createIframeHostServer({
    host: createInProcessHost('probe', []),
    manifest,
    props: {},
    guest: () => guest,
    onError: vi.fn(),
    onKey: vi.fn(),
    onTyping: vi.fn()
  });
  const from = (data: ToShell) =>
    s.handle({ data, source: guest, origin: 'null' } as unknown as MessageEvent);
  /** The latest value pushed for subscription `id`. */
  const latest = (id: number): unknown => {
    const pushes = posted.filter((m) => m.kind === 'push' && m.id === id);
    return (pushes[pushes.length - 1] as { value: unknown } | undefined)?.value;
  };
  return { posted, from, latest, s };
}

beforeEach(() => {
  resetHostsForTest();
  resetGrantsForTest();
  __resetMessages();
  setLocale('de');
});

afterEach(() => {
  __resetSettingsSync();
  __resetMessages();
  setLocale('');
});

describe('the shell hands a frame its own catalogs (MICA-235)', () => {
  it('sends the active locale for the caller’s namespace and ui, and nothing of another app', () => {
    registerDisk();
    const { from, latest } = server();
    from({ kind: 'subscribe', id: 1, facet: 'locale', factoryArgs: [], member: 'catalogs' });
    expect(latest(1)).toEqual({
      probe: { de: { hello: 'Hallo' }, en: { hello: 'Hello' } },
      ui: { de: { cancel: 'Abbrechen' } }
    });
  });

  it('pins the app id: a frame naming another app still gets only its own', () => {
    registerDisk();
    const { from, latest } = server();
    from({ kind: 'subscribe', id: 2, facet: 'locale', factoryArgs: ['rival'], member: 'catalogs' });
    expect(JSON.stringify(latest(2))).not.toContain('Geheimnis');
    expect(Object.keys(latest(2) as object).sort()).toEqual(['probe', 'ui']);
  });

  it('follows a locale switch, down the fallback chain to English', () => {
    registerDisk();
    const { from, latest } = server();
    from({ kind: 'subscribe', id: 3, facet: 'locale', factoryArgs: [], member: 'catalogs' });
    setLocale('fr');
    expect(latest(3)).toEqual({
      probe: { fr: { hello: 'Salut' }, en: { hello: 'Hello' } },
      ui: { fr: { cancel: 'Annuler' } }
    });
    setLocale('en');
    expect(latest(3)).toEqual({ probe: { en: { hello: 'Hello' } } });
  });

  it('pushes catalogs that arrive after the frame subscribed, and only when its slice moved', () => {
    const { from, latest, posted } = server();
    from({ kind: 'subscribe', id: 4, facet: 'locale', factoryArgs: [], member: 'catalogs' });
    expect(latest(4)).toEqual({});
    registerMessages('probe', { de: { hello: 'Hallo' } });
    expect(latest(4)).toEqual({ probe: { de: { hello: 'Hallo' } } });
    const before = posted.length;
    registerMessages('rival', { de: { secret: 'Geheimnis' } });
    expect(posted.length).toBe(before);
  });

  it('keeps setLocale out of a frame’s reach', async () => {
    const { from, posted } = server();
    from({
      kind: 'call',
      id: 5,
      facet: 'locale',
      factoryArgs: [],
      member: 'setLocale',
      args: ['fr']
    });
    await Promise.resolve();
    expect((posted[posted.length - 1] as { ok?: boolean }).ok).toBe(false);
  });
});
