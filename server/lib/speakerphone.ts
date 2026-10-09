// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from './FrameworkBridge';
import { playerCoords } from './playerCoords';
import { resource } from './framework/runtime';

/**
 * Speakerphone: the players standing near a phone on speaker hear the call, and the far
 * side hears them (MICA-246).
 *
 * ## The mechanism, and why it is this one
 *
 * pma-voice's calls are channels of server ids. Its server export `setPlayerCall(source,
 * channel)` puts a player in one; every member then targets every other member's voice and
 * plays theirs at the listener's call volume. There is no export or native that makes a
 * remote talker's voice come *out of* somebody else's phone — `MumbleSetSubmixForServerId`
 * filters a talker and `MumbleSetVolumeOverrideByServerId` sets their level, and nothing
 * moves where they are heard from — and nothing feeds game audio into the outgoing stream,
 * so the far side can only ever hear a bystander who is transmitting to it themselves.
 * `docs/testing-voip.md` has the whole reading of pma-voice's source this rests on.
 *
 * So a bystander in range is **added to the call channel**, by the server, and taken out
 * again when they walk away, the call ends, or the speaker goes off. Their own client
 * lowers what it hears the call at (`mica:client:phone:speakerListen`), which is the
 * "reduced volume" half; the audio is in their ear rather than from the phone, which is
 * the half no native in the release client can do.
 *
 * ## Who decides
 *
 * The server, from where the server says everybody is standing. The client asks for the
 * speaker to be on; it never names who is near it, and it never names a channel. A bystander
 * is told only that they are listening and how loud, never whose call it is.
 *
 * ## Why this polls
 *
 * The same reason `Music.ts` does: range depends on where people stand, which changes when
 * nobody touches a phone. With no speaker on, a tick reads nothing at all.
 */

const RANGE_CONVAR = 'mica_speaker_range';
const VOLUME_CONVAR = 'mica_speaker_volume';

/** Meters. A phone on a table, heard by the people at the table. */
const DEFAULT_RANGE = 4;

/** pma-voice's own 0-100 call-volume scale. Its default call volume is 60. */
const DEFAULT_VOLUME = 30;

/**
 * How many bystanders one speaker adds, nearest first.
 *
 * Every one of them is a new voice in the far side's ear, and a transmitter the far side did
 * not dial. A crowd around a phone is not a conference call, so this is a constant rather
 * than a convar.
 */
export const MAX_SPEAKER_LISTENERS = 6;

/**
 * Walking out of range drops a listener only past this multiple of it, so somebody standing
 * on the edge does not flicker in and out of the call every tick.
 */
const LEAVE_FACTOR = 1.25;

/** The event a bystander's client is told it is listening, or no longer is, on. */
export const SPEAKER_LISTEN_EVENT = 'mica:client:phone:speakerListen';

/**
 * The ceiling `mica_speaker_range` cannot be raised past. A phone on speaker is heard across
 * a room, not a street; past this, "nearby" becomes a way to put strangers into a call.
 */
export const MAX_SPEAKER_RANGE = 10;

/** The event a phone holder is told its speaker was switched off by the server on. */
export const SPEAKER_STATE_EVENT = 'mica:client:phone:speakerState';

/**
 * Range in meters, at most `MAX_SPEAKER_RANGE`. `0` or less turns speakerphone off, and the
 * control with it.
 */
export const speakerRange = (): number => {
  const raw =
    typeof GetConvarInt === 'function' ? GetConvarInt(RANGE_CONVAR, DEFAULT_RANGE) : DEFAULT_RANGE;
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_SPEAKER_RANGE) : 0;
};

/**
 * Whether `src`'s ped is dead, from the server's synced health. GTA's player peds die at 100
 * and below (a HUD shows health minus 100), so that is the line. Unknown reads as alive: a
 * missing native or ped is `playerCoords`'s business, which already skips them.
 */
const isDead = (src: number): boolean => {
  if (typeof GetPlayerPed !== 'function' || typeof GetEntityHealth !== 'function') return false;
  const ped = GetPlayerPed(String(src));
  if (!ped) return false;
  return GetEntityHealth(ped) <= 100;
};

/** What a bystander hears the call at, clamped to pma-voice's scale. */
export const speakerVolume = (): number => {
  const raw =
    typeof GetConvarInt === 'function'
      ? GetConvarInt(VOLUME_CONVAR, DEFAULT_VOLUME)
      : DEFAULT_VOLUME;
  if (!Number.isFinite(raw)) return DEFAULT_VOLUME;
  return Math.min(100, Math.max(1, Math.trunc(raw)));
};

/** The voice resource, reduced to the four things speakerphone asks of it. */
export interface VoiceBackend {
  /** Whether call channels exist at all on this server right now. */
  ready(): boolean;
  /** Put `src` in `channel`; `0` takes them out of whatever call channel they are in. */
  setCall(src: number, channel: number): void;
  /** The call channel `src` is in, `0` for none. */
  channelOf(src: number): number;
  /**
   * Forget `src`'s channel without the voice resource's help — for when `setCall` cannot run
   * because it has stopped. pma-voice rejoins whatever this says when it starts again.
   */
  clearChannel(src: number): void;
}

const PMA_VOICE = 'pma-voice';

/**
 * pma-voice, read from its source (`server/module/phone.lua`). `setPlayerCall` from another
 * resource also tells the player's own pma-voice client which channel it is in, and writes
 * `Player(src).state.callChannel`, which is what `channelOf` reads back.
 *
 * `voice_enableCalls` is pma-voice's own switch: with it off `setPlayerCall` returns without
 * doing anything, so a speaker offered then would be exactly the no-op the ticket forbids.
 */
const pmaVoice: VoiceBackend = {
  ready: () =>
    typeof GetResourceState === 'function' &&
    GetResourceState(PMA_VOICE) === 'started' &&
    (typeof GetConvarInt !== 'function' || GetConvarInt('voice_enableCalls', 1) === 1),
  setCall: (src, channel) => {
    resource(PMA_VOICE).setPlayerCall(src, channel);
  },
  channelOf: (src) => {
    if (typeof Player !== 'function') return 0;
    const channel = Number(Player(src)?.state?.callChannel);
    return Number.isFinite(channel) ? channel : 0;
  },
  // pma-voice's client re-reads `LocalPlayer.state.callChannel` on its own resource start
  // (`client/init/init.lua`) and rejoins it, so a stale value outlives the stop.
  clearChannel: (src) => {
    if (typeof Player !== 'function') return;
    Player(src)?.state?.set('callChannel', 0, true);
  }
};

let backend: VoiceBackend = pmaVoice;

/** Test seam. Pass nothing to restore pma-voice. */
export const __setVoiceBackend = (next?: VoiceBackend): void => {
  backend = next ?? pmaVoice;
};

/**
 * The voice resource, for `Phone.ts` to place a call's parties through (MICA-341), so a
 * call's parties and its bystanders are moved by one backend and one test seam.
 */
export const voiceBackend = (): VoiceBackend => backend;

/** Whether this server can put a phone on speaker at all. Asked per call, never cached. */
export const speakerAvailable = (): boolean => speakerRange() > 0 && backend.ready();

/** What `Phone.ts` knows and this module must not import `services/` to learn. */
export interface SpeakerCalls {
  /** The id of the *answered*, player-held call `src` is a party to, or null. */
  callOf(src: number): number | null;
  /** Whether `src` holds any call at all: ringing, connected, or reserved. */
  onCall(src: number): boolean;
}

/** Phone holder on speaker -> the call id it was switched on for. */
const speakers = new Map<number, number>();

/** Bystander -> the speaker that brought them in, and the channel it put them in. */
const listeners = new Map<number, { owner: number; callId: number }>();

/** Test seam, like `__resetCalls`. Forgets everything without telling pma-voice. */
export const __resetSpeakerphone = (): void => {
  speakers.clear();
  listeners.clear();
};

/** Read-only views for tests and for `Phone.ts`'s own checks. */
export const isSpeakerOn = (src: number): boolean => speakers.has(src);
export const speakerListeners = (): number[] => [...listeners.keys()];

/**
 * The call channel a speaker put `src` in, or null when no speaker brought them in. What
 * `Phone.ts` admits a listener back into when their own client rejoins it (MICA-341), so a
 * listener is let into the call they are hearing and no other.
 */
export const listenerChannel = (src: number): number | null => listeners.get(src)?.callId ?? null;

const bucketOf = (src: number): number =>
  typeof GetPlayerRoutingBucket === 'function' ? GetPlayerRoutingBucket(String(src)) : 0;

const distanceSquared = (a: [number, number, number], b: [number, number, number]): number => {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

/**
 * Take one bystander back out. Leaves pma-voice alone when they are no longer in this call's
 * channel — they joined a call of their own, or left by their own client — because setting
 * them to `0` then would hang up a call that is not ours.
 */
function release(src: number, notify = true): void {
  const entry = listeners.get(src);
  if (!entry) return;
  listeners.delete(src);

  if (backend.channelOf(src) === entry.callId) {
    try {
      backend.setCall(src, 0);
    } catch (error) {
      console.error(
        `[mica] speakerphone could not take ${src} out of call ${entry.callId}.`,
        error
      );
      // pma-voice has stopped: clear the state bag it would rejoin from on restart.
      try {
        backend.clearChannel(src);
      } catch {
        // No state bag either; nothing left that could rejoin them.
      }
    }
  }
  if (notify) emitNet(SPEAKER_LISTEN_EVENT, src, { listening: false });
}

function admit(src: number, owner: number, callId: number): void {
  try {
    backend.setCall(src, callId);
  } catch (error) {
    // Not in the channel, so not a listener: nothing to undo, and nothing to tell them.
    console.error(`[mica] speakerphone could not add ${src} to call ${callId}.`, error);
    return;
  }
  listeners.set(src, { owner, callId });
  emitNet(SPEAKER_LISTEN_EVENT, src, { listening: true, volume: speakerVolume() });
}

/** Switch `owner`'s speaker off, and let go of everybody it brought in. Idempotent. */
export function speakerOff(owner: number): void {
  speakers.delete(owner);
  // Deleting the entry being visited is well-defined for a Map, so no copy is needed.
  for (const [src, entry] of listeners) {
    if (entry.owner === owner) release(src);
  }
}

/**
 * A player has gone. Their pma-voice state went with them, so a departing listener is only
 * forgotten; a departing speaker still takes its bystanders out of the channel.
 */
export function speakerDropped(src: number): void {
  listeners.delete(src);
  speakerOff(src);
}

/** Every bystander out, for resource stop. */
export function speakerReleaseAll(): void {
  for (const owner of speakers.keys()) speakerOff(owner);
  for (const src of listeners.keys()) release(src);
}

/**
 * The `speaker` action. Refuses to switch on anything but an answered call the requester is
 * a party to, on a server that can carry it; switching off always succeeds. Answers what the
 * speaker now is, so the phone shows the server's word rather than its own guess.
 */
export function setSpeaker(
  owner: number,
  enabled: boolean,
  calls: SpeakerCalls
): { ok: boolean; enabled: boolean } {
  if (!enabled) {
    speakerOff(owner);
    return { ok: true, enabled: false };
  }

  const callId = calls.callOf(owner);
  if (callId === null || !speakerAvailable()) return { ok: false, enabled: false };

  speakers.set(owner, callId);
  tickSpeakers(calls);
  return { ok: true, enabled: true };
}

/**
 * One pass: drop what no longer holds, then fill each speaker up to its cap, nearest first.
 *
 * A candidate is anybody alive in the speaker's routing bucket, in range, holding no call of
 * their own, in no pma-voice call channel (another resource's call included), and not already
 * listening to a speaker.
 */
export function tickSpeakers(calls: SpeakerCalls): void {
  if (speakers.size === 0 && listeners.size === 0) return;

  const available = speakerAvailable();
  for (const [owner, callId] of speakers) {
    if (calls.callOf(owner) !== callId) {
      // The call ended or changed; its own `ended` already put the phone back to idle.
      speakerOff(owner);
    } else if (!available) {
      // Still on the call, but the server can no longer carry a speaker (pma-voice stopped,
      // range set to 0). The phone is told, or it would keep showing "on" over nothing.
      speakerOff(owner);
      emitNet(SPEAKER_STATE_EVENT, owner, { available: false });
    }
  }

  const range = speakerRange();
  const leaveSquared = (range * LEAVE_FACTOR) ** 2;
  for (const [src, entry] of listeners) {
    const ownerCoords = playerCoords(entry.owner);
    const coords = playerCoords(src);
    // Still in the channel this speaker put them in: a bystander whose own dial was refused
    // inside one tick left it through their own client, and must be free to be added again.
    const stays =
      speakers.get(entry.owner) === entry.callId &&
      backend.channelOf(src) === entry.callId &&
      !calls.onCall(src) &&
      !isDead(src) &&
      ownerCoords !== null &&
      coords !== null &&
      bucketOf(src) === bucketOf(entry.owner) &&
      distanceSquared(ownerCoords, coords) <= leaveSquared;
    if (!stays) release(src);
  }

  if (speakers.size === 0) return;

  const players = Object.keys(FrameworkBridge.getAllPlayers())
    .map(Number)
    .filter((src) => Number.isInteger(src) && src > 0);
  const rangeSquared = range * range;

  for (const [owner, callId] of speakers) {
    const origin = playerCoords(owner);
    if (!origin) continue;
    const bucket = bucketOf(owner);

    let room = MAX_SPEAKER_LISTENERS;
    for (const entry of listeners.values()) if (entry.owner === owner) room--;
    if (room <= 0) continue;

    const nearby: { src: number; distanceSquared: number }[] = [];
    for (const src of players) {
      if (src === owner || listeners.has(src) || calls.onCall(src)) continue;
      const coords = playerCoords(src);
      if (!coords) continue;
      const d = distanceSquared(origin, coords);
      if (d > rangeSquared || bucketOf(src) !== bucket) continue;
      if (backend.channelOf(src) !== 0 || isDead(src)) continue;
      nearby.push({ src, distanceSquared: d });
    }

    nearby.sort((a, b) => a.distanceSquared - b.distanceSquared);
    for (const { src } of nearby) {
      if (room <= 0) break;
      admit(src, owner, callId);
      if (listeners.has(src)) room--;
    }
  }
}
