// The client half of the music service: turning "somebody nearby is playing" into a volume.

import { sendNuiMessage } from '../lib/nui';
import { MusicProximity, type MusicLevel } from '../game/MusicProximity';
import {
  MAX_NEARBY_BROADCASTS,
  MUSIC_BROADCAST_NET_EVENT,
  MUSIC_BROADCAST_VOLUMES_NUI_ACTION,
  MUSIC_BROADCASTS_NUI_ACTION
} from '@gphone/shared/musicBroadcast';
import { isPlaylistId, isVideoId } from '@gphone/shared/youtube';

/**
 * MICA-111 phase 2, the client hop.
 *
 * Three things meet here and the split between them is AGENTS.md §8's, not an arbitrary one:
 *
 *   server → here   who is broadcasting, what, since when, paused or not. Deliberately no
 *                   volume: `shared/musicBroadcast.ts` says why, and the short version is
 *                   that a server cannot know where this particular ped is standing.
 *   here → game     source ids only. `client/game/MusicProximity.ts` holds the tick, the
 *                   distance and the curve, because a distance between two peds is GTA
 *                   world state and has no business in a service file.
 *   game → here     a volume per source.
 *   here → NUI      two messages. The roster, forwarded when the server pushes one; the
 *                   volumes, at whatever rate the listener is moving.
 *
 * **Two messages rather than one, deliberately.** The roster changes when somebody presses
 * play; the attenuation changes while the listener walks, several times a second. One
 * message would either resend every id and start time at walking pace or throttle the
 * volume to the roster's rate — and the second is exactly what makes distance sound like a
 * fault. `web/src/shell/state/nearbyMusic.ts` takes each as an independent snapshot and
 * tolerates them racing, which is what lets them run at different rates at all.
 *
 * ## What the volume is, and what it is not
 *
 * An **attenuation**: 0..1, distance only, before the listener's own music volume and
 * before any mute. Per-broadcaster mute and "mute all nearby music" are shell state and are
 * free to multiply this by zero — `rankAudible` in `web/src/lib/musicBroadcast.ts` applies
 * the mute before the cap, so muting the nearest person is how you hear the next one.
 * Nothing here knows whether any of that happened, which is the point: a mute that had to
 * round-trip through the game client would be a mute with a latency.
 *
 * ## Why nothing here is trimmed to the nearest few
 *
 * **This lane ranks and attenuates; the shell selects and renders.** Every broadcaster the
 * server sent goes on, ordered nearest first, each with its volume — no cap.
 *
 * Capping here would be a bug and not merely a duplicated responsibility, because **muting
 * lives in shell state and this file cannot see it**. A broadcaster trimmed here is
 * invisible to the mute list, so nobody could silence somebody standing fourth; and a
 * *muted* broadcaster would occupy one of the slots, so muting the person playing something
 * appalling would buy a silent slot instead of the next-nearest becoming audible. The shell
 * filters the muted first and takes its cap from what remains, which is the only order that
 * makes muting mean what a person expects.
 */

/**
 * One roster row as this file will admit it.
 *
 * Three identities, and they are not interchangeable:
 *
 * - **`source`** is a server id and a *connection*. It is what `GetPlayerFromServerId`
 *   takes, so it is the only one the world half can measure a distance to, and it is the
 *   key the volume map goes out under.
 * - **`token`** is an opaque, stable handle on the *person*, and it is the mute key.
 *   `shared/musicBroadcast.ts` sets out at length why a mute must never key on `source`:
 *   FiveM reuses server ids, so a mute keyed there is void the moment its target relogs —
 *   which is exactly the person a mute exists for — and the reused id eventually silences
 *   an innocent player who inherited the slot.
 * - **`label`** is a display name, for the "muted <who>" affordance, and is never a key.
 *
 * A row with no token is **dropped, loudly**. It is tempting to fall back to the source and
 * keep the audio working, and that is the trap: it produces a phone that plays music
 * perfectly and forgets every mute on reconnect, which is mute evasion arriving as a
 * feature nobody would notice was broken for weeks. Silence and a console error are the
 * honest failure.
 */
interface RosterRow {
  source: number;
  token: string;
  label: string | null;
  videoId: string | null;
  playlistId: string | null;
  startedAt: number;
  paused: boolean;
}

/** A display name is for a mute list, not a paragraph. */
const MAX_LABEL_LENGTH = 64;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Narrow one row, or drop it.
 *
 * The server is ours, so this is not a §2.9 trust boundary — but a malformed push must
 * leave the phone quiet rather than feed a `NaN` into a per-frame tick, and the ids are the
 * strings that eventually reach an `<iframe src>` in the shell. Holding them to
 * `shared/youtube.ts`'s own shapes here costs nothing and means the NUI is handed a bounded
 * token or nothing at all. The shell narrows again on receipt, for the reason
 * `parseAppEventEnvelope` gives: the browser harness posts straight into the NUI and never
 * crosses `client/`, so a check that only lived here would be absent in every browser run.
 */
const parseRow = (raw: unknown): RosterRow | null => {
  const row = asRecord(raw);
  if (!row) return null;

  const source = Number(row.source);
  if (!Number.isInteger(source) || source <= 0) return null;

  const videoId = typeof row.videoId === 'string' && isVideoId(row.videoId) ? row.videoId : null;
  const playlistId =
    typeof row.playlistId === 'string' && isPlaylistId(row.playlistId) ? row.playlistId : null;
  // Nothing to play is not a broadcaster. Dropped here rather than passed on, so the shell
  // never has to decide what an empty row means.
  if (!videoId && !playlistId) return null;

  // See `RosterRow`: no token, no audio. Never a fallback to the source.
  const token = typeof row.token === 'string' ? row.token.trim().slice(0, 64) : '';
  if (!token) {
    console.error(
      `[Music] Refusing to play a broadcast from source ${source} with no mute token. ` +
        'Playing it would make its broadcaster unmuteable, so it is dropped instead.'
    );
    return null;
  }

  const startedAt = Number(row.startedAt);
  return {
    source,
    token,
    label: typeof row.label === 'string' ? row.label.slice(0, MAX_LABEL_LENGTH) : null,
    videoId,
    playlistId,
    startedAt: Number.isFinite(startedAt) ? startedAt : 0,
    paused: row.paused === true
  };
};

/** The roster, by source — the key the world half answers in. Replaced wholesale on each push. */
let roster = new Map<number, RosterRow>();

/**
 * This client's own server id, resolved lazily.
 *
 * `GetPlayerServerId` is not meaningful before the player has spawned, and this module is
 * imported from the generated barrel at resource start, which is well before that.
 */
const ownSource = (): number => {
  const id = GetPlayerServerId(PlayerId());
  return Number.isInteger(id) ? id : -1;
};

/**
 * Forward the attenuation.
 *
 * **Keyed by `source`, not by `token`**, and the distinction matters in both directions. A
 * volume is a measurement of a *connection's* ped taken this frame — it is what the world
 * half natively produces and what `receiveNearbyVolumes` reads — while a mute is a fact
 * about a person and keys on the token carried on the roster row. Nothing is weakened by
 * the split: a broadcaster with no token never reaches the roster at all, so a volume can
 * only ever name somebody the shell already knows how to mute.
 *
 * A snapshot rather than a delta: a source that stops being mentioned is out of earshot,
 * and the shell reads it that way. A level whose source has already left the roster is
 * dropped rather than sent under a stale key — the world half keeps a departing entry alive
 * for a few hundred milliseconds while it fades, so this runs throughout a fade-out.
 */
const pushVolumes = (levels: MusicLevel[]): void => {
  const volumes: Record<string, number> = {};
  for (const level of levels) {
    if (roster.has(level.source)) volumes[String(level.source)] = level.volume;
  }
  sendNuiMessage(MUSIC_BROADCAST_VOLUMES_NUI_ACTION, { volumes });
};

MusicProximity.onUpdate(pushVolumes);

/**
 * The server's roster of who is broadcasting within its fan-out radius.
 *
 * The local player is dropped even though the server already excludes them: their own
 * playback is shell state from phase 1, and echoing it back would give them a second embed
 * of their own track a few hundred milliseconds out of sync with the first. Cheap, and it
 * survives the server changing its mind about who it addresses.
 */
onNet(MUSIC_BROADCAST_NET_EVENT, (raw: unknown) => {
  const envelope = asRecord(raw);
  // The wire calls the list `broadcasters` (`NearbyMusicEnvelope`) and the NUI calls it
  // `broadcasts` (`parseMusicBroadcasts` in `shared/nui.ts`). Not a typo on either side, and
  // this hop is the only place the two words meet — do not "fix" one to match the other
  // without changing the end that owns it.
  const list = Array.isArray(envelope?.broadcasters) ? envelope.broadcasters : null;
  if (!list) {
    console.error('[Music] Dropped a malformed nearby-music envelope from the server.');
    return;
  }

  const self = ownSource();
  const next = new Map<number, RosterRow>();
  for (const entry of list.slice(0, MAX_NEARBY_BROADCASTS)) {
    const row = parseRow(entry);
    // First mention of a source wins, so a duplicated row cannot occupy two roster slots.
    if (!row || row.source === self || next.has(row.source)) continue;
    next.set(row.source, row);
  }

  roster = next;
  // The whole row goes on, `source` included: the shell joins volumes by it and mutes by
  // `token`, and it is not this hop's place to decide which of those it is allowed to do.
  // No cap either — the shell ranks by the volume below, filters the muted, and takes its
  // own cap from what is left. Trimming here would hide a broadcaster from the mute list
  // and leave a muted one occupying a slot the next-nearest should have had.
  sendNuiMessage(MUSIC_BROADCASTS_NUI_ACTION, { broadcasts: [...roster.values()] });

  // The world half decides when to tick and when to stand down; an empty list is how
  // "nobody is broadcasting" is expressed, and it answers with one final empty volume push.
  MusicProximity.setSources([...roster.keys()]);
});
