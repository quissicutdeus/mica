// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-392. The shared DM inbox, over the in-process facets and over the iframe twins, as
 * `DmThread.test.ts` renders the thread. `__fixtures__/dmWorld.ts` is the server behind both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import type { DirectMessageThread } from '@mica/shared/types';
import { world, resetWorld, message, push } from './__fixtures__/dmWorld';

const twins = vi.hoisted(() => ({
  directMessages: null as null | ((appId: string) => unknown),
  appEvents: null as null | ((appId: string) => unknown)
}));

vi.mock('../host/useDirectMessages', async () => {
  const { world: w, inProcess: local } = await import('./__fixtures__/dmWorld');
  return {
    useDirectMessages: (appId: string) =>
      w.shape === 'frame' ? twins.directMessages!(appId) : local.directMessages(appId)
  };
});
vi.mock('../host/useAppEvents', async () => {
  const { world: w, inProcess: local } = await import('./__fixtures__/dmWorld');
  return {
    useAppEvents: (appId: string) =>
      w.shape === 'frame' ? twins.appEvents!(appId) : local.appEvents(appId)
  };
});
vi.mock('../host/iframe/remote', async (importOriginal) => {
  const { world: w } = await import('./__fixtures__/dmWorld');
  return {
    ...(await importOriginal<typeof import('../host/iframe/remote')>()),
    remoteCall: (...args: unknown[]) => w.remoteCall(...args)
  };
});
vi.mock('../host/iframe/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../host/iframe/transport')>()),
  clientTransport: () => ({ releaseCallback: () => {} })
}));

import DmInbox from './DmInbox.svelte';

const ME = 11;
const ALT = 12;

const thread = (
  peer: number,
  lastId: number,
  mine: number,
  sentByMe: boolean,
  extra: Partial<DirectMessageThread> = {}
): DirectMessageThread => ({
  peer_account_id: peer,
  handle: `user${peer}`,
  display_name: `User ${peer}`,
  last: sentByMe
    ? message(lastId, mine, peer, `to ${peer}`)
    : message(lastId, peer, mine, `from ${peer}`),
  unread: 0,
  ...extra
});

const peers = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="dm-inbox-row"]')].map((el) =>
    Number(el.dataset.peerAccountId)
  );

describe.each(['in-process', 'frame'] as const)('DmInbox, %s', (shape) => {
  beforeEach(async () => {
    resetWorld(shape);
    if (shape === 'frame') {
      twins.directMessages = (await import('../host/iframe/facets/directMessages')).directMessages;
      twins.appEvents = (await import('../host/iframe/facets/appEvents')).appEvents;
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it("lists the account's correspondents, newest activity first", async () => {
    world.threads.mockResolvedValue([
      thread(30, 5, ME, false),
      thread(40, 9, ME, true, { unread: 0 }),
      thread(50, 7, ALT, false, { unread: 2 }),
      thread(60, 8, ME, false, { unread: 3 })
    ]);
    const { container, getByText, getByLabelText } = render(DmInbox, {
      appId: 'glimpse',
      accountId: ME,
      onopen: vi.fn()
    });

    await waitFor(() => expect(peers(container)).toEqual([40, 60, 30]));
    expect(getByText('User 60')).toBeTruthy();
    expect(getByText('@user60')).toBeTruthy();
    expect(getByText('from 60')).toBeTruthy();
    expect(getByText(/to 40/).textContent).toContain('↪');
    expect(getByLabelText('3 unread').textContent?.trim()).toBe('3');
    if (shape === 'frame') {
      expect(world.remoteCall).toHaveBeenCalledWith('directMessages', ['glimpse'], 'threads');
    }
  });

  it('keeps every account when accountId is null', async () => {
    world.threads.mockResolvedValue([thread(30, 5, ME, false), thread(50, 7, ALT, false)]);
    const { container } = render(DmInbox, { appId: 'glimpse', accountId: null, onopen: vi.fn() });
    await waitFor(() => expect(peers(container)).toEqual([50, 30]));
  });

  it('hands the tapped thread to onopen', async () => {
    const row = thread(30, 5, ME, false);
    world.threads.mockResolvedValue([row]);
    const onopen = vi.fn();
    const { findByText } = render(DmInbox, { appId: 'glimpse', accountId: ME, onopen });
    await fireEvent.click(await findByText('User 30'));
    expect(onopen).toHaveBeenCalledWith(row);
  });

  it('reads again on a live dm push, and not on a replay', async () => {
    world.threads.mockResolvedValueOnce([thread(30, 5, ME, false)]);
    const { container } = render(DmInbox, { appId: 'glimpse', accountId: ME, onopen: vi.fn() });
    await waitFor(() => expect(peers(container)).toEqual([30]));

    push('glimpse', 'dm', { peer_account_id: 30 }, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.threads).toHaveBeenCalledTimes(1);

    world.threads.mockResolvedValueOnce([
      thread(70, 9, ME, false, { unread: 1 }),
      thread(30, 5, ME, false)
    ]);
    push('glimpse', 'dm', { peer_account_id: 70 });
    await waitFor(() => expect(peers(container)).toEqual([70, 30]));
    expect(world.threads).toHaveBeenCalledTimes(2);
  });

  it('says so when there is nothing, in its own words or the caller’s', async () => {
    const first = render(DmInbox, { appId: 'glimpse', accountId: ME, onopen: vi.fn() });
    expect(await first.findByText('No messages yet')).toBeTruthy();
    first.unmount();

    const second = render(DmInbox, {
      appId: 'glimpse',
      accountId: ME,
      empty: 'No matches yet',
      onopen: vi.fn()
    });
    expect(await second.findByText('No matches yet')).toBeTruthy();
  });

  it('answers an empty inbox when the read fails', async () => {
    world.threads.mockRejectedValueOnce(new Error('refused'));
    const { findByText } = render(DmInbox, { appId: 'glimpse', accountId: ME, onopen: vi.fn() });
    expect(await findByText('No messages yet')).toBeTruthy();
  });

  it('has no form, and its rows are plain buttons', async () => {
    world.threads.mockResolvedValue([thread(30, 5, ME, false)]);
    const { container } = render(DmInbox, { appId: 'glimpse', accountId: ME, onopen: vi.fn() });
    await waitFor(() => expect(peers(container)).toEqual([30]));
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[type="submit"]')).toBeNull();
  });
});
