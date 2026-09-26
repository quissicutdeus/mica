// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../../host/registerFacets';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';

import TaggedFeed from './TaggedFeed.svelte';
import { taggedBlabs } from '../store';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('blabber', { en, de });

/**
 * MICA-288. The feed used to subscribe to `taggedBlabs.hasMore` in component scope and drop the
 * unsubscriber, so every mount left a live subscription writing into a destroyed component.
 * A store does not expose its subscriber count, so the test counts open subscriptions itself.
 */
describe('TaggedFeed', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leaves no subscriber on hasMore after unmount', () => {
    const store = taggedBlabs.hasMore;
    const real = store.subscribe;
    let open = 0;
    vi.spyOn(store, 'subscribe').mockImplementation((...args) => {
      open += 1;
      const stop = real(...args);
      let done = false;
      return () => {
        if (!done) open -= 1;
        done = true;
        stop();
      };
    });

    const view = render(TaggedFeed, { props: { tag: 'mica' } });
    view.unmount();
    expect(open).toBe(0);
  });
});
