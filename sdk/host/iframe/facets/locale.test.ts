// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MICA-235, the frame's half: the `locale` twin over a fake transport, standing in for an
 * add-on's own bundle. The shell's half — what it may send, and to whom — is
 * `../../localeCatalogs.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { fakeTransport } from '../__fixtures__/fakeTransport';
import type { ToShell } from '../messages';
import { __resetMessages, locale as bundleLocale, registerMessages, t } from '../../../i18n';
import { locale } from './locale';

afterEach(() => {
  __resetMessages();
  bundleLocale.set('en');
});

describe('the locale twin (MICA-235)', () => {
  it('names no app, merges what the shell pushes, and follows once', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sent, pushes } = fakeTransport();
    registerMessages('probe', { en: { hello: 'Hello', bye: 'Bye' } });
    locale();
    const subs = sent.filter(
      (m): m is Extract<ToShell, { kind: 'subscribe' }> => m.kind === 'subscribe'
    );
    const idOf = (member: string) => subs.find((m) => m.member === member)!.id;
    expect(subs.map((m) => [m.facet, m.factoryArgs])).toEqual([
      ['locale', []],
      ['locale', []]
    ]);

    pushes.get(idOf('catalogs'))!({
      probe: { de: { hello: 'Hallo' }, en: { hello: 'Howdy' } }
    });
    expect(get(t)('probe.hello')).toBe('Howdy');
    expect(get(t)('probe.bye')).toBe('Bye');

    pushes.get(idOf('locale'))!('de');
    expect(get(bundleLocale)).toBe('de');
    expect(get(t)('probe.hello')).toBe('Hallo');
    expect(get(t)('probe.bye')).toBe('Bye');

    // A namespace `registerMessages` refuses is skipped, not fatal to the ones beside it.
    pushes.get(idOf('catalogs'))!({ 'Not-An-Id': { de: { x: 'x' } }, ui: { de: { ok: 'OK!' } } });
    expect(get(t)('ui.ok')).toBe('OK!');

    // Asked again — `useLocale()` after boot — it does not follow twice.
    locale();
    expect(sent.filter((m) => m.kind === 'subscribe')).toHaveLength(2);
  });
});
