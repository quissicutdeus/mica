// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nearbyBroadcastFixture } from '@gphone/shared/musicBroadcast.fixtures';

/**
 * The client hop of MICA-111 phase 2 — the half that takes the server's roster, hands
 * source ids to the world half, and forwards two NUI messages.
 *
 * The point of asserting this at all: a NUI feature fails *silently* when a layer is
 * missing (AGENTS.md §8), and nothing else stands behind `client/`. Playwright never loads
 * it, and `tsc` cannot tell that a message went out under the wrong action name.
 *
 * `MusicProximity` is mocked here rather than driven. What it is handed, and what it is
 * handed back, is this file's contract; the tick and the curve behind it are asserted in
 * `MusicProximity.test.ts` against the real thing.
 */

const { setSources, onUpdate } = vi.hoisted(() => ({
  setSources: vi.fn(),
  onUpdate: vi.fn()
}));

vi.mock('../game/MusicProximity', () => ({
  MusicProximity: { setSources, onUpdate }
}));

let netSubscriptions: Map<string, (data: unknown) => void>;
let sentNuiMessages: { action: string; data: unknown }[];
let ownServerId: number;

/**
 * A well-formed roster row, so each test can vary the one field it cares about.
 *
 * Built from `nearbyBroadcastFixture` rather than hand-rolled here. The three hops a
 * broadcast crosses used to describe the row in three vocabularies, and every suite stayed
 * green while they disagreed — a shared fixture makes a renamed field break all of them at
 * once, which is the moment it is cheapest to find.
 */
const row = (over: Record<string, unknown> = {}) =>
  ({ ...nearbyBroadcastFixture(), ...over }) as Record<string, unknown>;

/** The fixture's own values, read back rather than restated. */
const {
  source: SOURCE,
  token: TOKEN,
  label: LABEL,
  startedAt: STARTED_AT
} = nearbyBroadcastFixture();

const load = async () => {
  vi.resetModules();
  setSources.mockClear();
  onUpdate.mockClear();
  await import('../services/Music');
  const receive = netSubscriptions.get('gphone:client:shell:music');
  if (!receive) throw new Error('Music.ts did not subscribe to the broadcast event');
  return {
    receive,
    /** The callback `MusicProximity.onUpdate` was handed, i.e. the volume push. */
    emitLevels: onUpdate.mock.calls[0][0] as (
      levels: { source: number; volume: number; distance: number | null }[]
    ) => void
  };
};

const messagesFor = (action: string) => sentNuiMessages.filter((m) => m.action === action);

beforeEach(() => {
  netSubscriptions = new Map();
  sentNuiMessages = [];
  ownServerId = 1;

  const g = globalThis as Record<string, unknown>;
  g.onNet = (event: string, handler: (data: unknown) => void) =>
    netSubscriptions.set(event, handler);
  g.SendNuiMessage = (payload: unknown) => sentNuiMessages.push(JSON.parse(payload as string));
  g.PlayerId = () => 0;
  g.GetPlayerServerId = () => ownServerId;
});

describe('Music (client half)', () => {
  it('forwards the whole row, and hands the world half nothing but source ids', async () => {
    const { receive } = await load();

    receive({ at: 1700000001000, broadcasters: [row()] });

    const [message] = messagesFor('musicBroadcasts');
    expect(message.data).toEqual({
      broadcasts: [
        {
          source: SOURCE,
          token: TOKEN,
          label: LABEL,
          videoId: 'dQw4w9WgXcQ',
          playlistId: null,
          startedAt: STARTED_AT,
          paused: false
        }
      ]
    });
    expect(setSources).toHaveBeenCalledWith([SOURCE]);
  });

  it('sends every nearby broadcaster, because the shell mutes before it caps', async () => {
    const { receive } = await load();

    receive({
      at: 0,
      broadcasters: Array.from({ length: 8 }, (_, i) =>
        row({ source: i + 2, token: `k${i}f9xq2wm7t1` })
      )
    });

    // Trimming to the audible few here would hide a broadcaster from the mute list, and
    // would let a muted one hold a slot the next-nearest should have had.
    expect(
      (messagesFor('musicBroadcasts').at(-1)!.data as { broadcasts: unknown[] }).broadcasts
    ).toHaveLength(8);
  });

  it('keys the volume push on the server id, which is what a distance is measured against', async () => {
    const { receive, emitLevels } = await load();

    receive({ at: 0, broadcasters: [row(), row({ source: 9, token: 'z9mq4t7xk2vb' })] });
    emitLevels([
      { source: 9, volume: 0.8, distance: 4 },
      { source: SOURCE, volume: 0.2, distance: 18 }
    ]);

    // The mute key is `token`, carried on the roster row. The volume map is a measurement
    // of a connection's ped, so it keys on the connection.
    expect(messagesFor('musicBroadcastVolumes').at(-1)!.data).toEqual({
      volumes: { '9': 0.8, [String(SOURCE)]: 0.2 }
    });
  });

  it('refuses a broadcast with no mute token, loudly, rather than playing it unmuteable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { receive } = await load();

    receive({ at: 0, broadcasters: [row({ token: undefined }), row({ source: 8, token: '  ' })] });

    // Falling back to the server id here would give working audio and mutes that quietly
    // reset on reconnect — mute evasion, arriving as a feature nobody notices is broken.
    expect(setSources).toHaveBeenCalledWith([]);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('drops a level for a source that has already left the roster', async () => {
    const { receive, emitLevels } = await load();

    receive({ at: 0, broadcasters: [row()] });
    receive({ at: 0, broadcasters: [] });
    // The world half keeps a departing entry alive while it fades, so it keeps reporting
    // a source this file no longer has a row for. It must not invent a key for it.
    emitLevels([{ source: SOURCE, volume: 0.3, distance: 12 }]);

    expect(messagesFor('musicBroadcastVolumes').at(-1)!.data).toEqual({ volumes: {} });
  });

  it('drops the local player, so nobody gets a second copy of their own track', async () => {
    ownServerId = SOURCE;
    const { receive } = await load();

    receive({ at: 0, broadcasters: [row(), row({ source: 8, token: 'b8dw3jn6ls0p' })] });

    expect(messagesFor('musicBroadcasts').at(-1)!.data).toMatchObject({
      broadcasts: [{ token: 'b8dw3jn6ls0p' }]
    });
    expect(setSources).toHaveBeenCalledWith([8]);
  });

  it('drops rows with no playable id and rows with a malformed one', async () => {
    const { receive } = await load();

    receive({
      at: 0,
      broadcasters: [
        row({ source: 2, videoId: null, playlistId: null }),
        row({ source: 3, videoId: '"><script>' }),
        row({ source: 4, videoId: null, playlistId: 'PL' + 'a'.repeat(32) }),
        row({ source: 5, videoId: 'dQw4w9WgXcQ' })
      ]
    });

    expect(setSources).toHaveBeenCalledWith([4, 5]);
  });

  it('rejects a source that is not a usable server id', async () => {
    const { receive } = await load();

    receive({
      at: 0,
      broadcasters: [row({ source: 0 }), row({ source: -3 }), row({ source: 'seven' })]
    });

    expect(setSources).toHaveBeenCalledWith([]);
  });

  it('keeps the first mention of a duplicated source', async () => {
    const { receive } = await load();

    receive({
      at: 0,
      broadcasters: [row({ token: 'f1rst9xk2vbq' }), row({ token: 's2cnd4t7mq3z' })]
    });

    expect(messagesFor('musicBroadcasts').at(-1)!.data).toMatchObject({
      broadcasts: [{ token: 'f1rst9xk2vbq' }]
    });
  });

  it('bounds the roster, so one message cannot decide how much the tick costs', async () => {
    const { receive } = await load();

    receive({
      at: 0,
      broadcasters: Array.from({ length: 40 }, (_, i) =>
        row({ source: i + 2, token: `k${i}f9xq2wm7t1` })
      )
    });

    expect(setSources.mock.calls.at(-1)![0]).toHaveLength(16);
  });

  it('treats a malformed envelope as nothing rather than as an empty roster', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { receive } = await load();

    receive({ nonsense: true });
    receive(null);
    receive('broadcasters');

    expect(setSources).not.toHaveBeenCalled();
    expect(sentNuiMessages).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(3);
    error.mockRestore();
  });

  it('forwards an empty roster, which is how "nobody is nearby" is said', async () => {
    const { receive } = await load();

    receive({ at: 5, broadcasters: [] });

    expect(messagesFor('musicBroadcasts').at(-1)!.data).toEqual({ broadcasts: [] });
    expect(setSources).toHaveBeenCalledWith([]);
  });

  it('bounds a label rather than passing a wall of text to the mute list', async () => {
    const { receive } = await load();

    receive({ at: 0, broadcasters: [row({ label: 'x'.repeat(500) })] });

    const [broadcast] = (
      messagesFor('musicBroadcasts').at(-1)!.data as { broadcasts: { label: string }[] }
    ).broadcasts;
    expect(broadcast.label).toHaveLength(64);
  });
});
