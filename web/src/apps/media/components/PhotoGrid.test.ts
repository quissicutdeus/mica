// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../../../host/registerFacets';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import { useMedia } from '@mica/sdk';

import PhotoGrid from './PhotoGrid.svelte';

/**
 * MICA-288. The grid subscribed to `media.hasMore` in component scope and dropped the
 * unsubscriber, so every mount leaked a subscription into a destroyed component.
 */
describe('PhotoGrid', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leaves no subscriber on hasMore after unmount', () => {
    const store = useMedia().media.hasMore;
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

    const view = render(PhotoGrid, {
      props: { isSelectionMode: false, selectedIds: new Set<number>(), onphotoclick: () => {} }
    });
    view.unmount();
    expect(open).toBe(0);
  });
});
