// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against — in-process, because a
 * unit test stands in for the shell. `state/appDrawer` reaches the registry, which builds a
 * `usePersisted` store at module scope, so without this the file fails on import.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { searchQuery } from './appDrawer';
import {
  MAX_HITS_PER_APP,
  publishSearchHits,
  searchNeedle,
  searchProviders
} from './searchProviders';

/**
 * MICA-286: the shell's side of `useSearchProvider`, and specifically what it does with
 * an answer it did not ask for.
 *
 * Everything reaching `publishSearchHits` came out of a sandboxed frame over
 * `postMessage`, so these are not "what if an app has a bug" cases — the frame's own
 * TypeScript is not the shell's, and a hostile bundle has none at all.
 */

const hitsFor = (appId: string, needle: string) =>
  get(searchProviders)
    .find((provider) => provider.appId === appId)
    ?.search(needle);

describe('searchProviders', () => {
  beforeEach(() => searchQuery.set(''));

  it('normalises the needle the way searchEverything does', () => {
    searchQuery.set('  Safe HOUSE  ');
    expect(get(searchNeedle)).toBe('safe house');
  });

  it('lists what an app published for the needle being searched', () => {
    searchQuery.set('safe');
    publishSearchHits('notes', 'safe', [
      { id: 1, title: 'Safehouse code', subtitle: '4821', props: { noteId: 1 } }
    ]);

    expect(hitsFor('notes', 'safe')).toEqual([
      { id: 1, title: 'Safehouse code', subtitle: '4821', props: { noteId: 1 } }
    ]);
  });

  it('drops an answer to a needle the player has already typed past', () => {
    searchQuery.set('note');
    // The frame was pushed `not` first and its reply arrives a message late. Listing it
    // would show rows matching neither what was typed nor what is on screen.
    publishSearchHits('notes', 'not', [{ id: 1, title: 'Stale' }]);

    expect(get(searchProviders)).toEqual([]);
  });

  it('answers nothing to a needle other than the one it published for', () => {
    searchQuery.set('safe');
    publishSearchHits('notes', 'safe', [{ id: 1, title: 'Safehouse code' }]);

    // The second check, in `search` itself: the needle can move between the publish and
    // the render that reads it.
    expect(hitsFor('notes', 'safer')).toEqual([]);
  });

  it('refuses an answer to no search at all', () => {
    publishSearchHits('notes', '', [{ id: 1, title: 'Nothing was asked' }]);
    expect(get(searchProviders)).toEqual([]);
  });

  it('forgets every app once the search is over', () => {
    searchQuery.set('safe');
    publishSearchHits('notes', 'safe', [{ id: 1, title: 'Safehouse code' }]);
    expect(get(searchProviders)).toHaveLength(1);

    searchQuery.set('');
    expect(get(searchProviders)).toEqual([]);
  });

  it('keeps each app under its own name', () => {
    searchQuery.set('a');
    publishSearchHits('notes', 'a', [{ id: 1, title: 'A note' }]);
    publishSearchHits('snek', 'a', [{ id: 2, title: 'A score' }]);

    expect(
      get(searchProviders)
        .map((p) => p.appId)
        .sort()
    ).toEqual(['notes', 'snek']);
    expect(hitsFor('snek', 'a')).toEqual([
      { id: 2, title: 'A score', subtitle: undefined, props: undefined }
    ]);
  });

  it('caps what one app can make the shell hold', () => {
    searchQuery.set('a');
    const flood = Array.from({ length: MAX_HITS_PER_APP * 50 }, (_, i) => ({
      id: i,
      title: `Row ${i}`
    }));
    publishSearchHits('notes', 'a', flood);

    expect(hitsFor('notes', 'a')).toHaveLength(MAX_HITS_PER_APP);
  });

  it('drops a malformed hit rather than rendering an undefined row', () => {
    searchQuery.set('a');
    publishSearchHits('notes', 'a', [
      { id: 1, title: 'Kept' },
      { id: 2 },
      { title: 'No id' },
      { id: 3, title: '   ' },
      { id: 4, title: 42 },
      'not an object',
      null,
      { id: 5, title: 'Kept too', subtitle: 7, props: 'nope' }
    ]);

    expect(hitsFor('notes', 'a')).toEqual([
      { id: 1, title: 'Kept', subtitle: undefined, props: undefined },
      { id: 5, title: 'Kept too', subtitle: undefined, props: undefined }
    ]);
  });

  it('publishes nothing at all for something that is not a list of hits', () => {
    searchQuery.set('a');
    publishSearchHits('notes', 'a', { id: 1, title: 'Not a list' });
    publishSearchHits('snek', 'a', undefined);

    expect(hitsFor('notes', 'a')).toEqual([]);
    expect(hitsFor('snek', 'a')).toEqual([]);
  });

  it('ignores a needle that is not a string', () => {
    searchQuery.set('a');
    publishSearchHits('notes', 42, [{ id: 1, title: 'Kept' }]);
    expect(get(searchProviders)).toEqual([]);
  });
});
