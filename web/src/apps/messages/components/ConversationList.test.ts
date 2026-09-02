// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import type { UIConversation } from '@gphone/sdk';
import ConversationList from './ConversationList.svelte';

/**
 * The "load older conversations" control, which nothing else can reach (MICA-204).
 *
 * `hasMore` is true only past a 200-thread server page, and the browser mock answers with a
 * handful of fixtures, so the Playwright spec renders the inbox with the control absent
 * every time — a green e2e run is not evidence this works. That is precisely the shape of
 * bug AGENTS.md §8 warns about, so the control is pinned here instead.
 */
const conversation = (id: number): UIConversation => ({
  id,
  citizenid: 'my-id',
  is_group: false,
  status: 'active',
  target: `555-000${id}`,
  targetName: `Thread ${id}`,
  lastMessage: 'Earlier',
  lastMessageAt: '2026-07-24T21:00:00Z',
  unreadCount: 0,
  created_at: '2026-07-24T20:00:00Z',
  updated_at: '2026-07-24T21:00:00Z'
});

const props = (overrides: Record<string, unknown> = {}) => ({
  conversations: [conversation(1)],
  loaded: true,
  hasMore: false,
  loadingMore: false,
  query: '',
  showSearch: false,
  viewingArchive: false,
  myCitizenId: 'my-id',
  isLastMsgReadByOther: () => false,
  onselect: () => {},
  onloadmore: () => {},
  ...overrides
});

describe('ConversationList: older pages', () => {
  it('offers nothing to load when the server said this is the whole inbox', () => {
    const { queryByText } = render(ConversationList, { props: props() });
    expect(queryByText('Load older conversations')).toBeNull();
  });

  it('offers the next page once the server says there is one', async () => {
    const onloadmore = vi.fn();
    const { getByText } = render(ConversationList, {
      props: props({ hasMore: true, onloadmore })
    });

    await fireEvent.click(getByText('Load older conversations'));

    expect(onloadmore).toHaveBeenCalledTimes(1);
  });

  it('says it is working rather than looking unresponsive', () => {
    const { getByText, queryByText } = render(ConversationList, {
      props: props({ hasMore: true, loadingMore: true })
    });

    expect(getByText('Loading older conversations...')).toBeTruthy();
    expect(queryByText('Load older conversations')).toBeNull();
  });

  /**
   * The reason the control sits outside the loaded/empty block rather than inside it: the
   * archive tab and the search box narrow what has already been fetched, so a filtered view
   * can legitimately show nothing while whole pages remain unfetched behind it. Folding this
   * into the empty-state branch would strand the rest of the inbox.
   */
  it('survives a filter that hides every fetched row', () => {
    const { getByText } = render(ConversationList, {
      props: props({ conversations: [], hasMore: true, viewingArchive: true })
    });

    expect(getByText('No archived conversations')).toBeTruthy();
    expect(getByText('Load older conversations')).toBeTruthy();
  });

  it('offers nothing while the first page is still arriving', () => {
    const { queryByText } = render(ConversationList, {
      props: props({ loaded: false, hasMore: true })
    });
    expect(queryByText('Load older conversations')).toBeNull();
  });
});
