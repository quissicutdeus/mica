// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { vi } from 'vitest';
import type { DirectMessage, DirectMessageThread } from '@mica/shared/types';
import type { AppEvent } from '../../vocabulary/shell';

/**
 * The `dms` service and the app-events bus, as `DmInbox.test.ts` and `DmThread.test.ts` see
 * them (MICA-392). One fake behind both shapes a component can be rendered in:
 *
 * - **in-process**: the hooks answer `inProcess()` below, plain functions over this world,
 *   the way a core app's facets do.
 * - **in an add-on's frame**: the hooks answer the real iframe twins
 *   (`sdk/host/iframe/facets/`), and the stubbed `remoteCall` under them lands in `wire()`.
 *   That is the shape where a store method is missing and every call is a message, so a
 *   primitive that works in-process can still break there (MICA-254).
 */
type Handler = (event: AppEvent) => void;

export const world = {
  threads: vi.fn(async (): Promise<DirectMessageThread[]> => []),
  thread: vi.fn(
    async (_query: {
      account_id: number;
      peer_account_id: number;
      cursor?: number | null;
      limit?: number;
    }): Promise<{ rows: DirectMessage[]; nextCursor: number | null }> => ({
      rows: [],
      nextCursor: null
    })
  ),
  send: vi.fn(async (input: { account_id: number; peer_account_id: number; body: string }) =>
    message(1, input.account_id, input.peer_account_id, input.body)
  ),
  markRead: vi.fn(async (_input: { account_id: number; peer_account_id: number }) => true),
  handlers: [] as { app: string; event: string; fn: Handler }[],
  /** Which hooks the component gets: `'frame'` swaps in the iframe twins. */
  shape: 'in-process' as 'in-process' | 'frame',
  remoteCall: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
};

export const resetWorld = (shape: 'in-process' | 'frame') => {
  world.shape = shape;
  world.handlers = [];
  world.threads.mockReset().mockResolvedValue([]);
  world.thread.mockReset().mockResolvedValue({ rows: [], nextCursor: null });
  world.send
    .mockReset()
    .mockImplementation(async (input) =>
      message(1, input.account_id, input.peer_account_id, input.body)
    );
  world.markRead.mockReset().mockResolvedValue(true);
  world.remoteCall.mockReset().mockImplementation(wire);
};

/** A line from `from` to `to`, its timestamp derived from its id so order is stable. */
export const message = (id: number, from: number, to: number, body = `line ${id}`) =>
  ({
    id,
    from_account: from,
    to_account: to,
    body,
    read_at: null,
    status: 'active',
    created_at: new Date(Date.UTC(2026, 9, 1) + id * 60_000).toISOString(),
    updated_at: new Date(Date.UTC(2026, 9, 1) + id * 60_000).toISOString()
  }) satisfies DirectMessage;

/** The server pushing `event` to `app`. */
export const push = (
  app: string,
  event: string,
  payload: Record<string, unknown>,
  replayed = false
) => {
  for (const handler of world.handlers.filter((h) => h.app === app && h.event === event)) {
    handler.fn({ app, event, payload, at: Date.now(), replayed });
  }
};

/** The in-process hooks: what a core app's `useDirectMessages`/`useAppEvents` answer. */
export const inProcess = {
  directMessages: (_appId: string) => ({
    threads: () => world.threads(),
    thread: (query: Parameters<typeof world.thread>[0]) => world.thread(query),
    send: (input: Parameters<typeof world.send>[0]) => world.send(input),
    markRead: (input: Parameters<typeof world.markRead>[0]) => world.markRead(input)
  }),
  appEvents: (appId: string) => ({
    on: (event: string, fn: Handler) => {
      const entry = { app: appId, event, fn };
      world.handlers.push(entry);
      return () => {
        world.handlers = world.handlers.filter((h) => h !== entry);
      };
    },
    onAny: () => () => {},
    clear: () => {}
  })
};

/** The shell's side of the wall, for the frame shape: each `postMessage` call, answered. */
async function wire(...args: unknown[]): Promise<unknown> {
  const [facet, factoryArgs, member, ...rest] = args as [string, unknown[], string, ...unknown[]];
  const app = String(factoryArgs[0]);
  if (facet === 'appEvents' && member === 'on') {
    const [event, fn] = rest as [string, Handler];
    world.handlers.push({ app, event, fn });
    return () => {};
  }
  if (facet === 'directMessages') {
    const call = world[member as 'threads' | 'thread' | 'send' | 'markRead'] as (
      ...a: unknown[]
    ) => Promise<unknown>;
    return call(...rest);
  }
  throw new Error(`dmWorld: nothing answers ${facet}.${member}`);
}
