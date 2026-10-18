// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-392. The shared DM thread, rendered over both shapes a host hook can answer in: the
 * in-process facets a core app gets, and the iframe twins an add-on gets, over a stubbed
 * wire. `__fixtures__/dmWorld.ts` is the server behind both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import { ServiceRefusal } from '../lib/errors';
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
// The wire under the twins: every call is answered by the fixture's `wire`.
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

import DmThread from './DmThread.svelte';

const ME = 11;
const PEER = 22;

/** Newest first, as the wire answers: ids `to`..`from`. */
const page = (from: number, to: number, nextCursor: number | null) => ({
  rows: Array.from({ length: to - from + 1 }, (_, i) =>
    (to - i) % 2 === 0 ? message(to - i, ME, PEER) : message(to - i, PEER, ME)
  ),
  nextCursor
});

const ids = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="dm-message"]')].map((el) =>
    Number(el.dataset.messageId)
  );

const open = (props: Record<string, unknown> = {}) =>
  render(DmThread, { appId: 'glimpse', accountId: ME, peerAccountId: PEER, ...props });

describe.each(['in-process', 'frame'] as const)('DmThread, %s', (shape) => {
  beforeEach(async () => {
    resetWorld(shape);
    if (shape === 'frame') {
      twins.directMessages = (await import('../host/iframe/facets/directMessages')).directMessages;
      twins.appEvents = (await import('../host/iframe/facets/appEvents')).appEvents;
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('opens on the newest page, oldest at the top, then marks it read', async () => {
    world.thread.mockResolvedValueOnce(page(21, 60, 21));
    const onactivity = vi.fn();
    const { container } = open({ onactivity });

    await waitFor(() => expect(ids(container)).toHaveLength(40));
    expect(ids(container)[0]).toBe(21);
    expect(ids(container)[39]).toBe(60);
    expect(world.thread).toHaveBeenCalledWith({ account_id: ME, peer_account_id: PEER });
    await waitFor(() =>
      expect(world.markRead).toHaveBeenCalledWith({ account_id: ME, peer_account_id: PEER })
    );
    expect(world.markRead).toHaveBeenCalledTimes(1);
    expect(onactivity).toHaveBeenCalledTimes(1);
    if (shape === 'frame') {
      expect(world.remoteCall).toHaveBeenCalledWith('directMessages', ['glimpse'], 'markRead', {
        account_id: ME,
        peer_account_id: PEER
      });
    }
  });

  it('pages older lines in above on scroll, walking the cursor', async () => {
    world.thread.mockResolvedValueOnce(page(21, 60, 21)).mockResolvedValueOnce(page(1, 20, null));
    const { container, getByTestId } = open();
    await waitFor(() => expect(ids(container)).toHaveLength(40));

    const list = getByTestId('dm-thread-messages');
    list.scrollTop = 0;
    await fireEvent.scroll(list);

    await waitFor(() => expect(ids(container)).toHaveLength(60));
    expect(world.thread).toHaveBeenLastCalledWith({
      account_id: ME,
      peer_account_id: PEER,
      cursor: 21
    });
    expect(ids(container)[0]).toBe(1);
    expect(ids(container)).toEqual([...ids(container)].sort((a, b) => a - b));
  });

  it('appends a send once, even when a push brings the same line back', async () => {
    world.thread.mockResolvedValueOnce(page(1, 4, null));
    world.send.mockResolvedValueOnce(message(5, ME, PEER, 'hello'));
    const { container, getByRole } = open();
    await waitFor(() => expect(ids(container)).toEqual([1, 2, 3, 4]));

    const field = container.querySelector('textarea')!;
    await fireEvent.input(field, { target: { value: '  hello ' } });
    await fireEvent.click(getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(ids(container)).toEqual([1, 2, 3, 4, 5]));
    expect(world.send).toHaveBeenCalledWith({
      account_id: ME,
      peer_account_id: PEER,
      body: 'hello'
    });
    expect(field.value).toBe('');

    // The newest page, now holding both my line and a new one of theirs.
    world.thread.mockResolvedValueOnce({
      rows: [
        message(6, PEER, ME, 'hi back'),
        message(5, ME, PEER, 'hello'),
        ...page(1, 4, null).rows
      ],
      nextCursor: null
    });
    push('glimpse', 'dm', { peer_account_id: PEER });
    await waitFor(() => expect(ids(container)).toEqual([1, 2, 3, 4, 5, 6]));
    expect(container.querySelectorAll('[data-message-id="5"]')).toHaveLength(1);
  });

  it('hands onpage the lines each read, push and send brought in, and nothing else', async () => {
    world.thread.mockResolvedValueOnce(page(21, 60, 21)).mockResolvedValueOnce(page(1, 20, null));
    const onpage = vi.fn();
    const pageIds = (n: number) => (onpage.mock.calls[n][0] as { id: number }[]).map((m) => m.id);
    const { container, getByTestId, getByRole } = open({ onpage });

    // The first page, as held: oldest first.
    await waitFor(() => expect(onpage).toHaveBeenCalledTimes(1));
    expect(pageIds(0)).toEqual(Array.from({ length: 40 }, (_, i) => 21 + i));

    // An older page: only its own rows.
    const list = getByTestId('dm-thread-messages');
    list.scrollTop = 0;
    await fireEvent.scroll(list);
    await waitFor(() => expect(onpage).toHaveBeenCalledTimes(2));
    expect([...pageIds(1)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => 1 + i)
    );

    // A send: the one line.
    world.send.mockResolvedValueOnce(message(61, ME, PEER, 'hello'));
    await fireEvent.input(container.querySelector('textarea')!, { target: { value: 'hello' } });
    await fireEvent.click(getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onpage).toHaveBeenCalledTimes(3));
    expect(pageIds(2)).toEqual([61]);

    // A push: the newest page it read, which may repeat a line already held.
    world.thread.mockResolvedValueOnce({
      rows: [message(62, PEER, ME), message(61, ME, PEER, 'hello')],
      nextCursor: 60
    });
    push('glimpse', 'dm', { peer_account_id: PEER });
    await waitFor(() => expect(onpage).toHaveBeenCalledTimes(4));
    expect([...pageIds(3)].sort((a, b) => a - b)).toEqual([61, 62]);

    // A push whose read came back empty hands nothing over.
    world.thread.mockResolvedValueOnce({ rows: [], nextCursor: null });
    push('glimpse', 'dm', { peer_account_id: PEER });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onpage).toHaveBeenCalledTimes(4);
  });

  it('ignores a push from somebody else, and a replay', async () => {
    world.thread.mockResolvedValueOnce(page(1, 2, null));
    const { container } = open();
    await waitFor(() => expect(ids(container)).toEqual([1, 2]));
    const reads = world.thread.mock.calls.length;

    push('glimpse', 'dm', { peer_account_id: 99 });
    push('glimpse', 'dm', { peer_account_id: PEER }, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.thread.mock.calls.length).toBe(reads);
  });

  it('keeps a failed send in the field with one generic line, and toasts nothing', async () => {
    world.send.mockRejectedValueOnce(new Error('socket closed'));
    const { container, getByRole, findByTestId } = open();
    await waitFor(() => expect(world.markRead).toHaveBeenCalled());

    const field = container.querySelector('textarea')!;
    await fireEvent.input(field, { target: { value: 'hello' } });
    await fireEvent.click(getByRole('button', { name: 'Send' }));

    const failure = await findByTestId('dm-send-failed');
    expect(failure.textContent?.trim()).toBe("That message wasn't sent. Try again.");
    expect(failure.getAttribute('role')).toBe('alert');
    expect(field.value).toBe('hello');
    expect(ids(container)).toEqual([]);
    const facets = world.remoteCall.mock.calls.map((call) => call[0]);
    expect(facets).not.toContain('phoneNotification');
  });

  it("shows a refusal's own words, which the server meant for the player", async () => {
    world.send.mockRejectedValueOnce(
      new ServiceRefusal('server.blabberDms.blocked', 'You can’t message this account.')
    );
    const { container, getByRole, findByTestId } = open();
    await waitFor(() => expect(world.markRead).toHaveBeenCalled());
    await fireEvent.input(container.querySelector('textarea')!, { target: { value: 'hi' } });
    await fireEvent.click(getByRole('button', { name: 'Send' }));
    expect((await findByTestId('dm-send-failed')).textContent?.trim()).toBe(
      'You can’t message this account.'
    );
  });

  it('offers report on their lines only, and only when the app asks', async () => {
    world.thread.mockResolvedValue(page(1, 2, null));
    const onreport = vi.fn();
    const { container, getAllByRole } = open({ onreport });
    await waitFor(() => expect(ids(container)).toEqual([1, 2]));

    const reports = getAllByRole('button', { name: 'Report message' });
    expect(reports).toHaveLength(1);
    await fireEvent.click(reports[0]);
    expect(onreport).toHaveBeenCalledWith(expect.objectContaining({ id: 1, from_account: PEER }));
  });

  it('draws no report button when the app passes no onreport', async () => {
    world.thread.mockResolvedValue(page(1, 2, null));
    const { container, queryAllByRole } = open();
    await waitFor(() => expect(ids(container)).toEqual([1, 2]));
    expect(queryAllByRole('button', { name: 'Report message' })).toHaveLength(0);
  });

  it('caps the composer at bodyMax, 500 by default', async () => {
    const first = open();
    expect(first.container.querySelector('textarea')!.maxLength).toBe(500);
    first.unmount();
    const second = open({ bodyMax: 120 });
    expect(second.container.querySelector('textarea')!.maxLength).toBe(120);
  });

  it('has no form to submit, which a sandboxed frame would block', async () => {
    const { container } = open({ emoji: true });
    await waitFor(() => expect(world.markRead).toHaveBeenCalled());
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[type="submit"]')).toBeNull();
  });
});
