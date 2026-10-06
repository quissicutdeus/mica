// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { renderApp } from '@mica/sdk/testing';
import { ServiceRefusal } from '@mica/sdk';
import type { JobLineMessage, JobLineThread, JobView } from '@mica/shared/types';

/**
 * A job line's shared inbox (MICA-307), driven through the whole Jobs app.
 *
 * The transport stands in for the server per action: a contracted call rides the generic
 * `svc` action with `{ service, action, data }` and is keyed by `action`; a named one
 * (`startCall`) by its own name. Each test says exactly what the server answers.
 */
const answers = new Map<string, (data: unknown) => unknown>();
const fetchNui = vi.fn(
  async (action: string, payload?: { service?: string; action?: string; data?: unknown }) => {
    const handler = answers.get(payload?.service ? (payload.action ?? '') : action);
    return handler ? handler(payload?.service ? payload.data : payload) : null;
  }
);

vi.mock('../../nui/fetchNui', () => ({
  fetchNui: (...args: unknown[]) => fetchNui(...(args as [string, never])),
  isBrowser: () => true
}));

import Jobs from './index.svelte';
import manifest from './manifest';
import { jobs, jobsLoaded } from '../../services/jobs';
import { deliverAppEvent } from '../../shell/state/appEvents';
import { toast } from '../../shell/state/toast';
import { contacts } from '../../services/contacts';
import {
  closeInbox,
  closeThread,
  inbox,
  openLine,
  openThreadId,
  thread,
  threadCursor
} from './lineInbox';

const job = (over: Partial<JobView> & Pick<JobView, 'name' | 'label'>): JobView => ({
  grade: 0,
  gradeLabel: 'Grade',
  salary: 100,
  onDuty: true,
  isBoss: false,
  active: false,
  lines: [],
  societyBalance: null,
  ...over
});

const held = (): JobView[] => [
  job({
    name: 'police',
    label: 'LSPD',
    active: true,
    lines: [{ number: '911', label: 'Emergency', inbox: true }]
  }),
  job({
    name: 'mechanic',
    label: 'Los Santos Customs',
    onDuty: false,
    lines: [{ number: '555-0142', label: 'LSC Front Desk', inbox: false }]
  })
];

const threads = (): JobLineThread[] => [
  {
    conversation_id: 9101,
    from: '555-0188',
    last_message: 'Shots fired near the pier',
    last_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    awaiting_reply: true
  },
  {
    conversation_id: 9102,
    from: '555-0123',
    last_message: 'Units are on the way.',
    last_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    awaiting_reply: false
  }
];

const message = (over: Partial<JobLineMessage> & Pick<JobLineMessage, 'id'>): JobLineMessage => ({
  conversation_id: 9101,
  side: 'caller',
  message: 'Shots fired near the pier',
  has_attachments: false,
  created_at: '2026-10-05T21:58:00.000Z',
  ...over
});

const calls = (action: string) => fetchNui.mock.calls.filter((c) => c[1]?.action === action);

const lineEvent = (payload: Record<string, unknown>) =>
  deliverAppEvent({ app: 'jobs', event: 'line_message', payload, at: Date.now() });

const render = () => renderApp(Jobs, { id: 'jobs', permissions: manifest.permissions });

/** Render, wait for the cards, and open the 911 line's inbox. */
const openEmergency = async () => {
  const result = render();
  await result.findByText('Emergency');
  await fireEvent.click(screen.getByText('Emergency'));
  await screen.findByTestId('line-inbox');
  return result;
};

const openFirstThread = async () => {
  await openEmergency();
  await fireEvent.click(await screen.findByText('Lamar Davis'));
  await screen.findByTestId('line-thread');
};

beforeEach(() => {
  answers.clear();
  fetchNui.mockClear();
  // Module-scoped state outlives a test; the app is resident and so is its inbox.
  closeInbox();
  jobs.set([]);
  jobsLoaded.set(false);
  answers.set('getJobs', () => held());
  // Set rather than answered: the contacts list rides the SDK's own transport, which the
  // `fetchNui` mock above does not reach, so its foreground load fails and keeps this list.
  contacts.set([
    {
      id: 1,
      citizenid: 'LAMAR',
      firstname: 'Lamar',
      lastname: 'Davis',
      phone: '555-0188',
      favorite: false,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z'
    }
  ]);
  answers.set('lineInbox', () => threads());
});

describe('a line without an inbox', () => {
  it('keeps its call row and opens nothing', async () => {
    const { findByText } = render();
    await findByText('LSC Front Desk');

    await fireEvent.click(screen.getByText('LSC Front Desk'));

    expect(calls('lineInbox')).toHaveLength(0);
    expect(screen.queryByTestId('line-inbox')).toBeNull();
    expect(get(openLine)).toBeNull();
    // The row is still today's call row: it dials the line.
    expect(fetchNui).toHaveBeenCalledWith('startCall', { number: '555-0142' });
  });
});

describe('the inbox', () => {
  it('lists every thread with its caller, last message, age and the awaiting marker', async () => {
    await openEmergency();

    expect(calls('lineInbox')[0].slice(0, 2)).toEqual([
      'svc',
      { service: 'jobs', action: 'lineInbox', data: { number: '911' } }
    ]);
    const rows = await screen.findAllByTestId('line-thread-row');
    expect(rows).toHaveLength(2);
    // A saved contact reads by name; a stranger by number.
    expect(within(rows[0]).getByText('Lamar Davis')).toBeTruthy();
    expect(within(rows[1]).getByText('555-0123')).toBeTruthy();
    expect(within(rows[0]).getByText('Shots fired near the pier')).toBeTruthy();
    expect(within(rows[0]).getByText('5m ago')).toBeTruthy();
    expect(within(rows[1]).getByText('3h ago')).toBeTruthy();
    // Only the unanswered thread carries the marker.
    expect(rows.map((r) => r.dataset.awaiting)).toEqual(['true', 'false']);
    expect(screen.getAllByText('Awaiting reply')).toHaveLength(1);
  });

  it('says so when nobody has written to the line', async () => {
    answers.set('lineInbox', () => []);
    await openEmergency();
    expect(await screen.findByText('No messages yet')).toBeTruthy();
  });

  it('says the inbox is unavailable when the server refuses it, not that it is empty', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    answers.set('lineInbox', () => {
      throw new Error('You are not on duty for this line.');
    });
    await openEmergency();
    expect(await screen.findByText('Inbox unavailable')).toBeTruthy();
    expect(screen.queryByText('No messages yet')).toBeNull();
  });

  it('calling the line from its row does not open the inbox', async () => {
    const { findByText } = render();
    await findByText('Emergency');

    await fireEvent.click(screen.getAllByRole('button', { name: 'Call' })[0]);

    expect(fetchNui).toHaveBeenCalledWith('startCall', { number: '911' });
    expect(get(openLine)).toBeNull();
  });
});

describe('the inbox row', () => {
  it('is two sibling buttons, never a button holding a button (axe nested-interactive)', async () => {
    const { findByText } = render();
    await findByText('Emergency');

    const row = screen.getAllByTestId('job-line').find((el) => el.dataset.inbox === 'true')!;
    expect(row.getAttribute('role')).toBeNull();
    const controls = within(row).getAllByRole('button');
    expect(controls.map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON']);
    // Neither control holds the other: both are native buttons, so both take Tab.
    expect(controls[0].contains(controls[1])).toBe(false);
    expect(controls[1].textContent?.trim()).toBe('Call');

    await fireEvent.click(controls[0]);
    expect(get(openLine)?.number).toBe('911');
  });
});

describe('a thread', () => {
  beforeEach(() => {
    answers.set('lineThread', () => ({
      rows: [
        message({ id: 3, side: 'caller', message: 'Two people running north' }),
        message({ id: 2, side: 'caller', message: '', has_attachments: true }),
        message({ id: 1, side: 'caller', message: 'Shots fired near the pier' })
      ],
      nextCursor: null
    }));
  });

  it('reads oldest first, caller on one side, and names a photo without showing it', async () => {
    await openFirstThread();

    const bubbles = await screen.findAllByTestId('line-message');
    expect(bubbles).toHaveLength(3);
    expect(bubbles.map((b) => b.dataset.side)).toEqual(['caller', 'caller', 'caller']);
    expect(bubbles[0].textContent).toContain('Shots fired near the pier');
    expect(bubbles[2].textContent).toContain('Two people running north');
    expect(within(bubbles[1]).getByText('Photo sent')).toBeTruthy();
    expect(bubbles[1].querySelector('img')).toBeNull();
    expect(calls('lineThread')[0][1]).toMatchObject({
      data: { number: '911', conversation_id: 9101 }
    });
  });

  it('appends the reply the server returns, clears the draft and stops the thread waiting', async () => {
    answers.set('lineReply', (data) =>
      message({
        id: 4,
        side: 'line',
        message: (data as { message: string }).message,
        created_at: new Date().toISOString()
      })
    );
    await openFirstThread();

    const field = screen.getByRole<HTMLTextAreaElement>('textbox');
    await fireEvent.input(field, { target: { value: 'Units en route' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(get(thread).map((m) => m.id)).toEqual([1, 2, 3, 4]));
    expect(calls('lineReply')[0][1]).toMatchObject({
      data: { number: '911', conversation_id: 9101, message: 'Units en route' }
    });
    const last = screen.getAllByTestId('line-message').slice(-1)[0];
    expect(last.dataset.side).toBe('line');
    expect(last.textContent).toContain('Units en route');
    await waitFor(() => expect(field.value).toBe(''));
    expect(get(inbox).find((t) => t.conversation_id === 9101)?.awaiting_reply).toBe(false);
  });

  it('toasts a failed send and leaves the draft where it was', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const show = vi.spyOn(toast, 'show');
    answers.set('lineReply', () => {
      throw new Error('You are no longer on duty.');
    });
    await openFirstThread();

    const field = screen.getByRole<HTMLTextAreaElement>('textbox');
    await fireEvent.input(field, { target: { value: 'Units en route' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          app: 'jobs',
          message: 'You are no longer on duty.'
        })
      )
    );
    expect(field.value).toBe('Units en route');
    expect(get(thread).map((m) => m.id)).toEqual([1, 2, 3]);
    show.mockRestore();
  });

  it('pages older messages by keyset and puts them above', async () => {
    answers.set('lineThread', (data) =>
      (data as { cursor?: number }).cursor === 3
        ? { rows: [message({ id: 2 }), message({ id: 1 })], nextCursor: null }
        : { rows: [message({ id: 4 }), message({ id: 3 })], nextCursor: 3 }
    );
    await openFirstThread();

    await fireEvent.click(await screen.findByText('Load older messages'));

    await waitFor(() => expect(get(thread).map((m) => m.id)).toEqual([1, 2, 3, 4]));
    expect(calls('lineThread')[1][1]).toMatchObject({ data: { cursor: 3 } });
    expect(screen.queryByText('Load older messages')).toBeNull();
  });
});

describe('line_message', () => {
  it('refreshes the inbox and the open thread for the line on screen', async () => {
    answers.set('lineThread', () => ({ rows: [message({ id: 1 })], nextCursor: null }));
    await openFirstThread();
    const inboxReads = calls('lineInbox').length;
    const threadReads = calls('lineThread').length;

    answers.set('lineThread', () => ({
      rows: [message({ id: 2, message: 'They went into the tunnel' }), message({ id: 1 })],
      nextCursor: null
    }));
    lineEvent({ number: '911', conversation_id: 9101 });

    await waitFor(() => expect(calls('lineInbox').length).toBe(inboxReads + 1));
    await waitFor(() => expect(calls('lineThread').length).toBe(threadReads + 1));
    await waitFor(() => expect(get(thread).map((m) => m.id)).toEqual([1, 2]));
    expect(await screen.findByText('They went into the tunnel')).toBeTruthy();
  });

  it('refreshes only the inbox when another thread on the line changed', async () => {
    answers.set('lineThread', () => ({ rows: [message({ id: 1 })], nextCursor: null }));
    await openFirstThread();
    const threadReads = calls('lineThread').length;
    const inboxReads = calls('lineInbox').length;

    lineEvent({ number: '911', conversation_id: 9102 });

    await waitFor(() => expect(calls('lineInbox').length).toBe(inboxReads + 1));
    expect(calls('lineThread').length).toBe(threadReads);
  });

  it('ignores a line that is not open', async () => {
    await openEmergency();
    const inboxReads = calls('lineInbox').length;

    lineEvent({ number: '555-0142', conversation_id: 1 });
    lineEvent({ conversation_id: 9101 });

    await Promise.resolve();
    expect(calls('lineInbox').length).toBe(inboxReads);
  });

  it('reads nothing while no inbox is open', async () => {
    const { findByText } = render();
    await findByText('Emergency');

    lineEvent({ number: '911', conversation_id: 9101 });

    await Promise.resolve();
    expect(calls('lineInbox')).toHaveLength(0);
    expect(get(openThreadId)).toBeNull();
  });
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * The server's one refusal for every inbox action, as `fetchNui` hands it back: a
 * `ServiceRefusal` keyed `server.jobs.lineUnavailable` (MICA-310). The message is deliberately
 * not the catalog's wording, so nothing here passes by matching text — a reworded or
 * translated catalog is exactly this.
 */
const REFUSAL_TEXT = 'Reworded: you cannot use this line.';
const refused = () => new ServiceRefusal('server.jobs.lineUnavailable', REFUSAL_TEXT);

describe('a refusal (review fix 2)', () => {
  it('clears cached rows and shows the inbox unavailable when a refresh is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openEmergency();
    expect(await screen.findAllByTestId('line-thread-row')).toHaveLength(2);

    answers.set('lineInbox', () => {
      throw refused();
    });
    lineEvent({ number: '911', conversation_id: 9101 });

    expect(await screen.findByText('Inbox unavailable')).toBeTruthy();
    expect(screen.queryAllByTestId('line-thread-row')).toHaveLength(0);
    expect(get(inbox)).toEqual([]);
  });

  it('keeps cached rows when the refresh fails for any other reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openEmergency();
    expect(await screen.findAllByTestId('line-thread-row')).toHaveLength(2);
    const reads = calls('lineInbox').length;

    answers.set('lineInbox', () => {
      throw new Error('Request timed out');
    });
    lineEvent({ number: '911', conversation_id: 9101 });

    await waitFor(() => expect(calls('lineInbox').length).toBe(reads + 1));
    await Promise.resolve();
    expect(screen.getAllByTestId('line-thread-row')).toHaveLength(2);
    expect(screen.queryByText('Inbox unavailable')).toBeNull();
  });

  it.each([
    [
      'the refusal’s exact English with no key',
      () => new Error('That line is not available to you.')
    ],
    ['a different keyed refusal', () => new ServiceRefusal('server.generic', REFUSAL_TEXT)]
  ])('keeps cached rows for %s (MICA-310)', async (_, failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openEmergency();
    expect(await screen.findAllByTestId('line-thread-row')).toHaveLength(2);
    const reads = calls('lineInbox').length;

    answers.set('lineInbox', () => {
      throw failure();
    });
    lineEvent({ number: '911', conversation_id: 9101 });

    await waitFor(() => expect(calls('lineInbox').length).toBe(reads + 1));
    await Promise.resolve();
    expect(screen.getAllByTestId('line-thread-row')).toHaveLength(2);
    expect(screen.queryByText('Inbox unavailable')).toBeNull();
  });

  it('closes the thread and empties the line when a reply is refused, and toasts why', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const show = vi.spyOn(toast, 'show');
    answers.set('lineThread', () => ({ rows: [message({ id: 1 })], nextCursor: null }));
    answers.set('lineReply', () => {
      throw refused();
    });
    await openFirstThread();

    const field = screen.getByRole<HTMLTextAreaElement>('textbox');
    await fireEvent.input(field, { target: { value: 'Units en route' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Inbox unavailable')).toBeTruthy();
    expect(get(openThreadId)).toBeNull();
    expect(get(thread)).toEqual([]);
    expect(get(inbox)).toEqual([]);
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: REFUSAL_TEXT })
    );
    show.mockRestore();
  });
});

describe('drafts (review fix 3)', () => {
  it('a send that lands after the reader moved threads clears only its own draft', async () => {
    const pending = deferred<JobLineMessage>();
    answers.set('lineThread', () => ({ rows: [message({ id: 1 })], nextCursor: null }));
    answers.set('lineReply', () => pending.promise);
    await openFirstThread();

    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Units en route' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls('lineReply')).toHaveLength(1));

    // Back to the inbox and into the other thread, typing there while the first send is out.
    closeThread();
    await fireEvent.click(await screen.findByText('555-0123'));
    await screen.findByTestId('line-thread');
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Half typed' } });

    pending.resolve(message({ id: 9, side: 'line', message: 'Units en route' }));
    await waitFor(() =>
      expect(get(inbox).find((row) => row.conversation_id === 9101)?.awaiting_reply).toBe(false)
    );

    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Half typed');
    // And the sent thread's own draft is gone when the reader goes back to it.
    closeThread();
    await fireEvent.click(await screen.findByText('Lamar Davis'));
    await screen.findByTestId('line-thread');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('');
  });
});

describe('out-of-order thread answers (review fix 4)', () => {
  it('keeps the row a refresh brought in when the opening load answers after it', async () => {
    const first = deferred<{ rows: JobLineMessage[]; nextCursor: number | null }>();
    let call = 0;
    answers.set('lineThread', () => {
      call += 1;
      return call === 1
        ? first.promise
        : {
            rows: [message({ id: 2, message: 'They went north' }), message({ id: 1 })],
            nextCursor: null
          };
    });
    await openEmergency();
    await fireEvent.click(await screen.findByText('Lamar Davis'));

    // A push lands before the opening load has answered; its refresh answers first.
    lineEvent({ number: '911', conversation_id: 9101 });
    await waitFor(() => expect(get(thread).map((m) => m.id)).toEqual([1, 2]));

    first.resolve({ rows: [message({ id: 1 })], nextCursor: 1 });
    await waitFor(() => expect(get(threadCursor)).toBe(1));
    expect(get(thread).map((m) => m.id)).toEqual([1, 2]);
  });

  it('drops an inbox answer older than the newest request', async () => {
    const slow = deferred<JobLineThread[]>();
    let call = 0;
    answers.set('lineInbox', () => {
      call += 1;
      if (call === 1) return threads();
      if (call === 2) return slow.promise;
      return [threads()[0]];
    });
    await openEmergency();
    expect(await screen.findAllByTestId('line-thread-row')).toHaveLength(2);

    lineEvent({ number: '911', conversation_id: 9101 });
    lineEvent({ number: '911', conversation_id: 9101 });
    await waitFor(() => expect(get(inbox)).toHaveLength(1));

    slow.resolve(threads());
    await Promise.resolve();
    await Promise.resolve();
    expect(get(inbox)).toHaveLength(1);
  });
});

/**
 * jsdom lays nothing out, so the scroller gets a height of 100px per rendered message, a
 * 300px window, and a `scrollTop` that remembers what it was set to.
 */
const fakeScroll = (el: HTMLElement) => {
  let top = 0;
  const height = () => el.querySelectorAll('[data-testid="line-message"]').length * 100;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    }
  });
  return {
    get top() {
      return top;
    },
    set top(value: number) {
      top = value;
    },
    height
  };
};

describe('scrolling (review fix 1)', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => message({ id: n - i, message: `row ${n - i}` }));

  /** Open 9101 with the first page held back until the scroller is faked. */
  const openScrolled = async (count: number) => {
    const page = deferred<{ rows: JobLineMessage[]; nextCursor: number | null }>();
    answers.set('lineThread', () => page.promise);
    await openEmergency();
    await fireEvent.click(await screen.findByText('Lamar Davis'));
    const scroll = fakeScroll(await screen.findByTestId('line-thread'));
    page.resolve({ rows: rows(count), nextCursor: null });
    await waitFor(() => expect(screen.getAllByTestId('line-message')).toHaveLength(count));
    return scroll;
  };

  const push = async (count: number) => {
    answers.set('lineThread', () => ({ rows: rows(count), nextCursor: null }));
    lineEvent({ number: '911', conversation_id: 9101 });
    await waitFor(() => expect(screen.getAllByTestId('line-message')).toHaveLength(count));
  };

  it('opens at the newest message', async () => {
    const scroll = await openScrolled(5);
    expect(scroll.top).toBe(500);
  });

  it('follows a pushed message down when the reader was at the bottom', async () => {
    const scroll = await openScrolled(5);
    await push(6);
    expect(scroll.top).toBe(600);
  });

  it('does not jump a reader who has scrolled up', async () => {
    const scroll = await openScrolled(5);
    scroll.top = 0;
    await push(6);
    expect(scroll.top).toBe(0);
  });

  it('scrolls the player’s own reply into view even from scrolled up', async () => {
    answers.set('lineReply', () =>
      message({
        id: 50,
        side: 'line',
        message: 'Units en route',
        created_at: new Date().toISOString()
      })
    );
    const scroll = await openScrolled(5);
    scroll.top = 0;

    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Units en route' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(scroll.top).toBe(600));
  });
});
