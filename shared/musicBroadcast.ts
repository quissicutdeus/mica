// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a phone playing out loud tells everybody standing next to it.
 *
 * MICA-111 phase 2. Phase 1 proved the embed and phase 3 built the queue, both entirely
 * inside one client — you heard your own music and nobody else did. This is the wire
 * between the server, which is the only thing that knows who is near whom, and the shell's
 * own player, which is the only thing that can make a sound.
 *
 * ## Why the event is `shell`-scoped and not `music`-scoped
 *
 * The thing being driven is the shell's player (`web/src/shell/`), not the Music app —
 * closing the app must not silence a neighbour's stereo any more than it silences your
 * own. `shell` is the established segment for "the phone itself rather than any app"
 * (`mica:client:shell:notify`, `mica:client:shell:appEvent`), and `server/lib/shell.ts`
 * already registers it as a service, so `eventNames.test.ts` checks this name for free.
 *
 * It is deliberately **not** an `appEventChannel` push either. That channel addresses an
 * app by id and is delivered to `useAppEvents(appId)` subscribers; there is no app here to
 * subscribe, and routing shell hardware through an app's inbox would mean an uninstalled
 * or never-opened app deciding whether sound comes out.
 *
 * ## What is on the wire, and what is deliberately not
 *
 * - **No volume.** Only the client knows where it is standing, so attenuation is computed
 *   there from `source`, which is exactly what `GetPlayerFromServerId` takes.
 * - **No mute state.** A mute is a listener's preference, not a disclosure boundary — the
 *   same call MICA-63 made for notification sounds — so it is applied client-side and
 *   never costs the fan-out a per-recipient lookup.
 * - **No URL, ever.** Ids only; `shared/youtube.ts` explains at length why the difference
 *   matters when the value's destination is an `<iframe src>`.
 * - **No citizenid.** A neighbour's stable identity is not something being nearby should
 *   disclose — `defineService`'s public projection strips it automatically for the same
 *   reason. What a mute list actually needs is not *who* somebody is but *that this is the
 *   same somebody as last time*, and `token` below says exactly that and nothing more.
 */

/**
 * The one net event. A literal, so `eventNames.test.ts` sees it — the same reasoning
 * `APP_EVENT_NET_EVENT` records for itself.
 */
export const MUSIC_BROADCAST_NET_EVENT = 'mica:client:shell:music';

/**
 * Metres. What `mica_music_range` defaults to when a server sets nothing.
 *
 * Read by the server, which decides who is on a listener's roster, and by
 * `client/services/Music.ts`, which decides what that roster sounds like. Both read the
 * same convar with the same default on purpose — and it must be set with `setr` to reach a
 * client at all, or the two halves silently disagree about where the fade starts.
 */
export const DEFAULT_MUSIC_RANGE = 30;

/**
 * How many broadcasters one listener's roster may name.
 *
 * This is the *roster* cap, not the audible one: the client ranks by its own attenuation
 * and plays the nearest few (`web/src/lib/musicBroadcast.ts`), because only it knows the
 * distances that ranking depends on. The server's job is to keep the list it hands over
 * bounded — nearest first, so what falls off the end is what was least likely to be heard.
 */
export const DEFAULT_MAX_NEARBY = 8;

/**
 * The ceiling `mica_music_max_nearby` cannot be raised past.
 *
 * A convar is a server owner's dial, not a licence: the client's tick costs one entity
 * position per roster entry per frame, and it holds no more than this many anyway.
 */
export const MAX_NEARBY_BROADCASTS = 16;

/** One neighbour's phone, and what it is playing. */
export interface NearbyBroadcast {
  /**
   * The broadcaster's server id — what `GetPlayerFromServerId` takes, so it is how the
   * client finds the ped to measure a distance to.
   *
   * **Never key a mute on this.** FiveM reuses server ids: a mute keyed here is void the
   * moment its target relogs, which is precisely the person a mute exists for, and the
   * reused id would eventually silence an innocent player who inherited the slot and has
   * no way to find out why nobody can hear them. `token` is the key.
   */
  source: number;
  /**
   * A stable, opaque handle on the person behind the broadcast. The mute key.
   *
   * Issued by the server, one per character, and **not derived from the citizenid** — not
   * even by hashing it, because a constant salt in an open-source repo is not a salt. It is
   * a random token held in a lookup table, so there is nothing in it to reverse and nothing
   * to correlate against anything else the phone knows.
   *
   * It says only what a mute list needs: this is the same broadcaster as before. It
   * therefore survives a reconnect and a change of server id, which is the case durable
   * muting exists for.
   *
   * Its one limit, and it is deliberate rather than discovered: **the table lives in the
   * resource, so tokens are reissued on restart and persisted mutes are forgotten there.**
   * Surviving a relog is what matters; surviving a restart is a nicety, and the cost of the
   * alternative is a stored cross-session identifier for every player who has ever pressed
   * play.
   */
  token: string;
  /** `Firstname Lastname` if the framework will say, for the "muted <who>" affordance. */
  label: string | null;
  /** The video being played, or `null` when the source is a playlist the embed advances. */
  videoId: string | null;
  /** The playlist being played through, when there is one. */
  playlistId: string | null;
  /**
   * The server-clock instant this track's 0:00 maps to, in epoch ms.
   *
   * The whole sync design, in one number: a client entering range seeks to
   * `now - startedAt`. No clock exchange, and drift over a track is tolerated deliberately.
   *
   * For a **paused** broadcast it is recomputed at send time so that `now - startedAt` is
   * the frozen position rather than a number that keeps growing while nothing is playing.
   */
  startedAt: number;
  /** Whether the broadcaster has it paused. A paused broadcast holds its position. */
  paused: boolean;
}

export interface NearbyMusicEnvelope {
  /** Server clock at send, ms. What `startedAt` is relative to. */
  at: number;
  /**
   * Everything within range of where the recipient is standing, nearest first.
   *
   * A **complete** roster rather than a delta: a listener who missed one message would
   * otherwise keep playing a broadcast that ended, and the whole list is at most
   * `MAX_NEARBY_BROADCASTS` rows. An empty array means "you are out of range of
   * everything", which is a normal message and not a dropped one.
   */
  broadcasters: NearbyBroadcast[];
}

/**
 * The NUI action the roster becomes, once `client/services/Music.ts` has forwarded it.
 *
 * A separate namespace from net events, so no `mica:` prefix (AGENTS.md §8) — and named
 * here rather than written out at each end, because the client hop and
 * `web/src/shell/nuiMessages.ts` are the only two things that will ever say it and a typo
 * between them is a feature that is dead in game while every suite passes. `parseMusicBroadcasts`
 * in `shared/nui.ts` accepts either a bare array or `{ broadcasts }`; the client sends the
 * latter.
 */
export const MUSIC_BROADCASTS_NUI_ACTION = 'musicBroadcasts';

/**
 * The NUI action the *volumes* become — a second message, deliberately.
 *
 * The roster changes when somebody presses play; the attenuation changes while the
 * listener is walking, several times a second. Riding them on one message would either
 * resend every id and start time at walking pace or throttle the volume to the roster's
 * rate, and the second is what makes distance sound like a fault rather than distance.
 * `web/src/shell/state/nearbyMusic.ts` treats each as an independent snapshot and tolerates
 * them racing, which is what lets them run at different rates at all.
 *
 * The payload is `{ volumes: Record<id, number> }`, keyed exactly as the roster is.
 */
export const MUSIC_BROADCAST_VOLUMES_NUI_ACTION = 'musicBroadcastVolumes';
