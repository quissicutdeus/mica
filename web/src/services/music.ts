// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import { call } from '../nui/call';
import { musicContract } from '@mica/shared/contracts/music';
import { musicPosition, musicSeek, musicSource, musicStatus } from '../shell/state/music';
import type { MusicSource } from '@mica/sdk';

/**
 * Telling the server what this phone is playing out loud. MICA-111 phase 2.
 *
 * The outbound half of proximity audio, and the mirror of `shell/state/nearbyMusic.ts`:
 * that module is what *other* people's phones announced, this is what yours announces.
 * The server holds the roster and fans it out to whoever is standing near you
 * (`server/services/Music.ts`); nothing here knows or asks who that is.
 *
 * ## Why this is a subscriber rather than a call in the transport
 *
 * Every one of the five things worth announcing — a track starting, ending, a queue
 * advancing, a pause, a seek — is already a change in `shell/state/music.ts`, and several
 * of them have more than one caller (`playSource`, `playQueueIndex`, `nextTrack`,
 * `advanceAfterEnd` and `removeFromQueue` all load a track). Announcing from each call
 * site would be five places to forget, and the one that got forgotten would be a
 * broadcaster whose neighbours keep hearing a song they stopped playing.
 *
 * Watching the state instead means there is exactly one definition of "what this phone is
 * playing", and it is the same one the phone plays from. It also means an add-on driving
 * playback through the SDK is announced without knowing this file exists.
 *
 * Subscribed at module scope, which on a page CEF never unloads means for the session —
 * the same reasoning `state/music.ts`'s own call subscription records. A subscription
 * inside a component would stop announcing the moment the phone was closed, which is
 * exactly when music is still playing and everybody nearby can still hear it.
 *
 * ## What is deliberately not sent
 *
 * The volume. It is the listener's, not the broadcaster's — how loud your music is on
 * somebody else's phone is their distance and their setting, and neither is yours to
 * state. The server sends no volume either; the game client computes one per listener
 * (`client/game/MusicProximity.ts`).
 *
 * The mute list, for the same reason in the other direction: a mute is a listener's local
 * decision and the broadcaster is never told (`shell/state/nearbyMusic.ts`).
 *
 * ## Failures are swallowed, and that is the right call here
 *
 * Nothing below reports an error to anybody. A failed announce means the people around you
 * do not hear your music — it does not mean *you* stopped hearing it, and a toast saying
 * "could not tell the server you are playing music" is an interruption about a thing the
 * person did not ask for and cannot fix. The next state change re-announces, which is the
 * recovery.
 */

const isPlayingIntent = (status: string): boolean => status === 'playing' || status === 'loading';

const sameSource = (a: MusicSource | null, b: MusicSource | null): boolean =>
  a !== null && b !== null && a.videoId === b.videoId && a.playlistId === b.playlistId;

/** Where the player says it is, as the server's unit. */
const positionMs = (): number => Math.max(0, Math.round(get(musicPosition).current * 1000));

/**
 * What the server has been told, so nothing is said twice.
 *
 * `musicStatus` and `musicSource` both fire on changes that are not news to a broadcast —
 * `loading` becoming `playing` is the same track still playing — and each redundant
 * announce is a net event and a fan-out to everybody in range.
 */
let announced: MusicSource | null = null;
let announcedPaused = false;
let announcedSeek = 0;

let started = false;
let queued = false;

/**
 * Coalesce every change in a tick into one announce, and the reason is a real bug.
 *
 * `goTo` in `state/music.ts` writes five stores in sequence — the index, the resume index,
 * the position, the error, and only then the status. Announcing straight from a store
 * subscription therefore saw the *new source* while the status was still the old one, read
 * `idle` as "paused", and told the server the track had started paused; the status write a
 * line later then unpaused it. Every track change was a start, a pause and a resume, and
 * the pause was fanned out to everybody in range.
 *
 * A microtask is the right amount of waiting. It is still the same tick from a person's
 * point of view — nothing is deferred to a frame or a timer — and it is exactly long
 * enough for a batch of store writes that belong to one action to finish being one action.
 */
const schedule = (): void => {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    sync();
  });
};

/**
 * Three named calls rather than one `send(action, …)` helper, and the reason is a test.
 *
 * `server/__tests__/routes.test.ts` scans `web/src` for a call site's literal action name to
 * prove every action has a caller and every caller reaches something registered — the check
 * that catches a NUI round trip missing one of its layers, which fails *silently in game*
 * while every suite passes (AGENTS.md §8). An action name assembled from a variable is
 * invisible to that scanner, so this feature would have read as three dead actions and no
 * live calls. Typed now (MICA-213), so the contract types the payload as well as naming
 * it, and the scanner reads the same three literals it always did.
 *
 * All three are deliberately unawaited: a failed announce means the people around you cannot
 * hear your music, which is not something to log on every pause or tell the person about —
 * see the note at the top of this file. Unawaited is the whole of it; the `{ quiet: true }`
 * these once passed did nothing, because `fetchNui` reads that option only for a call that
 * was given a default to fall back to and none of these were.
 */
const announceStart = (data: {
  videoId?: string;
  playlistId?: string;
  positionMs?: number;
}): void => {
  void call(musicContract, 'broadcastStart', data);
};

const announceUpdate = (data: { paused?: boolean; positionMs?: number }): void => {
  void call(musicContract, 'broadcastUpdate', data);
};

const announceStop = (): void => {
  void call(musicContract, 'broadcastStop', undefined);
};

function sync(): void {
  const source = get(musicSource);
  const status = get(musicStatus);
  const seek = get(musicSeek);
  const seekToken = seek?.token ?? 0;

  // A refused track counts as not playing. The phone is showing an error and no sound is
  // coming out of it, so leaving the neighbours' players running would be broadcasting
  // silence — and, worse, holding a slot of their cap against somebody audible.
  if (!source || status === 'error') {
    announcedSeek = seekToken;
    if (!announced) return;
    announced = null;
    announcedPaused = false;
    announceStop();
    return;
  }

  if (!sameSource(announced, source)) {
    announced = source;
    announcedPaused = !isPlayingIntent(status);
    // The seek token is caught up rather than reset: a seek issued against the track being
    // replaced is not a seek in the new one.
    announcedSeek = seekToken;
    // `?? undefined` rather than passing the store's `null` through: `MusicSource` says
    // "this is not a playlist" with `null`, and the contract's optional string does not
    // accept one (`shared/contracts/music.ts`). Nothing changes on the wire — `undefined`
    // is dropped by `JSON.stringify` and the handler reads an absent field exactly as it
    // read a null one — but the payload now matches what the server declared it accepts.
    announceStart({
      videoId: source.videoId ?? undefined,
      playlistId: source.playlistId ?? undefined,
      positionMs: positionMs()
    });
    // Loading something already paused cannot happen through the transport today, but a
    // start that silently dropped the pause would be a broadcaster paused on their own
    // phone and playing on everybody else's.
    if (announcedPaused) announceUpdate({ paused: true, positionMs: positionMs() });
    return;
  }

  const paused = !isPlayingIntent(status);
  const seeked = seekToken !== announcedSeek;
  announcedSeek = seekToken;

  if (paused !== announcedPaused) {
    announcedPaused = paused;
    // The position rides along in both directions. The server compares it against where it
    // thinks the track is and only treats a real difference as a seek, so this costs
    // nothing when it agrees and repairs the drift when it does not — which also covers a
    // seek that happened in the same tick, hence the early return.
    announceUpdate({ paused, positionMs: positionMs() });
    return;
  }

  /**
   * A seek is the one change neither the source nor the status expresses.
   *
   * Scrubbing leaves both exactly as they were — that is the whole reason `MusicSeek` is a
   * token in the first place — so without this, moving the playhead would desynchronise
   * every listener until the next track. The target comes off the request rather than off
   * `musicPosition`, because `repeat: 'one'` seeks to zero without the player having
   * reported anything.
   */
  if (seeked && seek) {
    announceUpdate({ positionMs: Math.max(0, Math.round(seek.seconds * 1000)) });
  }
}

/**
 * Start announcing. Called once, by `Shell.svelte`.
 *
 * An explicit call rather than a bare side-effect import, so that deleting the line is a
 * visible change to the shell rather than an import that looks unused — this module
 * exports nothing else, and an "unused import" is exactly what a tidy-up removes.
 */
export function installMusicBroadcast(): void {
  if (started) return;
  started = true;

  // All three through `schedule`, never `sync` directly — a track change writes several of
  // these in one action and it is one announce. `musicSeek` is here rather than on its own
  // subscription so that a seek arriving in the same tick as a pause is folded into that
  // pause's payload instead of racing it.
  musicSource.subscribe(schedule);
  musicStatus.subscribe(schedule);
  musicSeek.subscribe(schedule);
}

/** @internal Test-only: forget what the server has been told. */
export function resetMusicBroadcastForTest(): void {
  announced = null;
  announcedPaused = false;
  announcedSeek = 0;
  started = false;
  queued = false;
}
