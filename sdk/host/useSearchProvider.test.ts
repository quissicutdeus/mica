// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-286. Driven end to end through the in-process facet rather than a stub: the hook,
 * the facet and `shell/state/searchProviders.ts` are three files that only mean anything
 * together, and a mocked facet here would prove the hook calls something rather than that
 * an app's rows actually reach the drawer's `SearchProvider[]`.
 *
 * MICA-176: a test file has no entry point, so it says which facet set its subject
 * resolves against. In-process, because a unit test stands in for the shell.
 */
import '../../web/src/host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { useSearchProvider } from './useSearchProvider';
import { searchQuery } from '../../web/src/shell/state/appDrawer';
import { searchProviders } from '../../web/src/shell/state/searchProviders';

/** What the drawer would list from this app, for the query the player typed. */
const hitsFor = (appId: string, typed: string) => {
  const needle = typed.trim().toLowerCase();
  return (
    get(searchProviders)
      .find((p) => p.appId === appId)
      ?.search(needle) ?? []
  ).map((hit) => hit.title);
};

describe('useSearchProvider', () => {
  const releases: (() => void)[] = [];
  const register = (appId: string, search: Parameters<typeof useSearchProvider>[1]) => {
    const release = useSearchProvider(appId, search);
    releases.push(release);
    return release;
  };

  beforeEach(() => searchQuery.set(''));

  afterEach(() => {
    for (const release of releases.splice(0)) release();
    searchQuery.set('');
  });

  it('answers the needle the shell asked, and lists what it answered', () => {
    const search = vi.fn(() => [{ id: 1, title: 'Safehouse code', props: { noteId: 1 } }]);
    register('notes', search);

    searchQuery.set('Safe');

    // Trimmed and lower-cased before the app ever sees it, so an app matches against one
    // spelling rather than repeating the normalisation.
    expect(search).toHaveBeenCalledWith('safe');
    expect(hitsFor('notes', 'Safe')).toEqual(['Safehouse code']);
  });

  it('is asked nothing while nothing is being searched', () => {
    const search = vi.fn(() => [{ id: 1, title: 'Safehouse code' }]);
    register('notes', search);

    searchQuery.set('   ');

    expect(search).not.toHaveBeenCalled();
    expect(hitsFor('notes', '')).toEqual([]);
  });

  it('drops what it published once the query is cleared', () => {
    register('notes', () => [{ id: 1, title: 'Safehouse code' }]);

    searchQuery.set('safe');
    expect(hitsFor('notes', 'safe')).toEqual(['Safehouse code']);

    // `closeDrawer` clears the query, and a snapshot of an app's rows has no reason to
    // outlive the search that asked for it.
    searchQuery.set('');
    expect(get(searchProviders)).toEqual([]);
  });

  it('keeps the phone searchable when one app throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    register('notes', () => {
      throw new Error('the list is not loaded');
    });
    register('snek', () => [{ id: 'hi', title: 'High score' }]);

    searchQuery.set('hi');

    // The thrower contributes nothing rather than taking the search down with it, and says
    // so once rather than once per keystroke.
    expect(hitsFor('notes', 'hi')).toEqual([]);
    expect(hitsFor('snek', 'hi')).toEqual(['High score']);
    searchQuery.set('hig');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('stops contributing once released', () => {
    const search = vi.fn(() => [{ id: 1, title: 'Safehouse code' }]);
    const release = register('notes', search);

    release();
    searchQuery.set('safe');

    expect(search).not.toHaveBeenCalled();
    expect(hitsFor('notes', 'safe')).toEqual([]);
  });
});
