// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Speakerphone's bystander scan (MICA-246): who is put in a call channel, who is taken out,
 * and when pma-voice is left alone. The call state machine that drives it is `phone.test.ts`;
 * here the calls are a fixture, so every rule can be tried on its own.
 */

const world = vi.hoisted(() => ({
  players: new Set<number>(),
  coords: {} as Record<string, [number, number, number]>,
  buckets: {} as Record<string, number>
}));

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getAllPlayers: () =>
      Object.fromEntries([...world.players].map((src) => [src, { PlayerData: {} }]))
  }
}));

import {
  MAX_SPEAKER_LISTENERS,
  SPEAKER_LISTEN_EVENT,
  __resetSpeakerphone,
  __setVoiceBackend,
  isSpeakerOn,
  setSpeaker,
  speakerDropped,
  speakerListeners,
  speakerOff,
  speakerReleaseAll,
  speakerVolume,
  tickSpeakers,
  type SpeakerCalls
} from '../lib/speakerphone';

const CALL = 424242;
const OWNER = 1;

const channels = new Map<number, number>();
let ready = true;
const setCall = vi.fn((src: number, channel: number) => {
  if (channel === 0) channels.delete(src);
  else channels.set(src, channel);
});

/** Who is on a call, and which answered call each party holds. */
const onCall = new Set<number>();
const answered = new Map<number, number>();
const calls: SpeakerCalls = {
  callOf: (src) => answered.get(src) ?? null,
  onCall: (src) => onCall.has(src)
};

const place = (src: number, at: [number, number, number], bucket = 0) => {
  world.players.add(src);
  world.coords[String(src)] = at;
  world.buckets[String(src)] = bucket;
};

const pushes = (src: number) =>
  (globalThis.emitNet as any).mock.calls
    .filter((c: unknown[]) => c[0] === SPEAKER_LISTEN_EVENT && c[1] === src)
    .map((c: unknown[]) => c[2]);

let convars: Record<string, number> = {};

beforeEach(() => {
  __resetSpeakerphone();
  channels.clear();
  setCall.mockClear();
  setCall.mockImplementation((src: number, channel: number) => {
    if (channel === 0) channels.delete(src);
    else channels.set(src, channel);
  });
  ready = true;
  __setVoiceBackend({ ready: () => ready, setCall, channelOf: (src) => channels.get(src) ?? 0 });
  onCall.clear();
  answered.clear();
  world.players.clear();
  for (const key of Object.keys(world.coords)) delete world.coords[key];
  for (const key of Object.keys(world.buckets)) delete world.buckets[key];
  convars = {};

  (globalThis as any).emitNet = vi.fn();
  (globalThis as any).GetConvarInt = (name: string, fallback: number) => convars[name] ?? fallback;
  (globalThis as any).GetPlayerPed = (src: string) => (world.coords[src] ? `ped-${src}` : 0);
  (globalThis as any).DoesEntityExist = (ped: string) =>
    Boolean(world.coords[String(ped).slice(4)]);
  (globalThis as any).GetEntityCoords = (ped: string) => world.coords[String(ped).slice(4)];
  (globalThis as any).GetPlayerRoutingBucket = (src: string) => world.buckets[src] ?? 0;

  // The owner and the far party, both on the answered call.
  place(OWNER, [0, 0, 0]);
  place(2, [900, 0, 0]);
  onCall.add(OWNER).add(2);
  answered.set(OWNER, CALL).set(2, CALL);
});

afterEach(() => {
  __setVoiceBackend();
  delete (globalThis as any).GetPlayerPed;
  delete (globalThis as any).DoesEntityExist;
  delete (globalThis as any).GetEntityCoords;
  delete (globalThis as any).GetPlayerRoutingBucket;
});

describe('switching it on', () => {
  it('adds whoever is within range, and nobody past it', () => {
    place(3, [2, 0, 0]);
    place(4, [4, 0, 0]);
    place(5, [4.5, 0, 0]);

    expect(setSpeaker(OWNER, true, calls)).toEqual({ ok: true, enabled: true });

    expect(speakerListeners().toSorted()).toEqual([3, 4]);
    expect(channels.get(3)).toBe(CALL);
    expect(channels.has(5)).toBe(false);
  });

  it('follows mica_speaker_range', () => {
    convars.mica_speaker_range = 10;
    place(3, [9, 0, 0]);

    setSpeaker(OWNER, true, calls);

    expect(speakerListeners()).toEqual([3]);
  });

  it('is off entirely at range 0, and refuses', () => {
    convars.mica_speaker_range = 0;
    place(3, [1, 0, 0]);

    expect(setSpeaker(OWNER, true, calls)).toEqual({ ok: false, enabled: false });
    expect(setCall).not.toHaveBeenCalled();
  });

  it('refuses when the voice resource cannot carry a call channel', () => {
    ready = false;
    place(3, [1, 0, 0]);

    expect(setSpeaker(OWNER, true, calls)).toEqual({ ok: false, enabled: false });
    expect(isSpeakerOn(OWNER)).toBe(false);
  });

  it('refuses without an answered call', () => {
    answered.delete(OWNER);

    expect(setSpeaker(OWNER, true, calls)).toEqual({ ok: false, enabled: false });
  });

  it('caps the bystanders, nearest first', () => {
    for (let i = 0; i < MAX_SPEAKER_LISTENERS + 2; i++) place(10 + i, [0.3 * (i + 1), 0, 0]);

    setSpeaker(OWNER, true, calls);

    const expected = Array.from({ length: MAX_SPEAKER_LISTENERS }, (_, i) => 10 + i);
    expect(speakerListeners().toSorted((a, b) => a - b)).toEqual(expected);
  });

  it('tells a bystander how loud, and nothing about the call', () => {
    place(3, [1, 0, 0]);

    setSpeaker(OWNER, true, calls);

    expect(pushes(3)).toEqual([{ listening: true, volume: 30 }]);
  });
});

describe('who is never added', () => {
  it('somebody in another routing bucket, however close', () => {
    place(3, [1, 0, 0], 7);
    setSpeaker(OWNER, true, calls);
    expect(speakerListeners()).toEqual([]);
  });

  it('somebody holding a call of their own', () => {
    place(3, [1, 0, 0]);
    onCall.add(3);
    setSpeaker(OWNER, true, calls);
    expect(speakerListeners()).toEqual([]);
  });

  it("somebody already in a pma-voice call channel, another resource's included", () => {
    place(3, [1, 0, 0]);
    channels.set(3, 99);
    setSpeaker(OWNER, true, calls);
    expect(speakerListeners()).toEqual([]);
    expect(channels.get(3)).toBe(99);
  });

  it('somebody pma-voice would not take -- and they are told nothing', () => {
    place(3, [1, 0, 0]);
    setCall.mockImplementation(() => {
      throw new Error('No such export setPlayerCall');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    setSpeaker(OWNER, true, calls);

    expect(speakerListeners()).toEqual([]);
    expect(pushes(3)).toEqual([]);
    error.mockRestore();
  });
});

describe('who is taken back out', () => {
  beforeEach(() => {
    place(3, [1, 0, 0]);
    setSpeaker(OWNER, true, calls);
    expect(speakerListeners()).toEqual([3]);
  });

  it('nobody standing at the edge -- the leave distance is past the join distance', () => {
    world.coords['3'] = [4.8, 0, 0];
    tickSpeakers(calls);
    expect(speakerListeners()).toEqual([3]);
  });

  it('somebody who walks away', () => {
    world.coords['3'] = [6, 0, 0];
    tickSpeakers(calls);

    expect(speakerListeners()).toEqual([]);
    expect(channels.has(3)).toBe(false);
    expect(pushes(3).at(-1)).toEqual({ listening: false });
  });

  it('everybody, when the call is no longer answered', () => {
    answered.clear();
    tickSpeakers(calls);

    expect(isSpeakerOn(OWNER)).toBe(false);
    expect(channels.has(3)).toBe(false);
  });

  it('everybody, when the voice resource goes away', () => {
    ready = false;
    tickSpeakers(calls);
    expect(speakerListeners()).toEqual([]);
  });

  it('a bystander whose own call started, without hanging that call up', () => {
    onCall.add(3);
    channels.set(3, 555555); // their own client already joined their own call
    tickSpeakers(calls);

    expect(speakerListeners()).toEqual([]);
    expect(setCall).not.toHaveBeenCalledWith(3, 0);
    expect(channels.get(3)).toBe(555555);
    // Still told, so their client puts its call volume back.
    expect(pushes(3).at(-1)).toEqual({ listening: false });
  });

  it('everybody the speaker brought in, when it is switched off', () => {
    speakerOff(OWNER);
    expect(channels.has(3)).toBe(false);
    expect(isSpeakerOn(OWNER)).toBe(false);
  });

  it('a bystander who drops is only forgotten -- pma-voice already let go', () => {
    setCall.mockClear();
    speakerDropped(3);
    expect(speakerListeners()).toEqual([]);
    expect(setCall).not.toHaveBeenCalled();
  });

  it('everybody, on resource stop', () => {
    speakerReleaseAll();
    expect(channels.has(3)).toBe(false);
    expect(isSpeakerOn(OWNER)).toBe(false);
  });
});

describe('speakerVolume', () => {
  it('defaults to 30 and clamps to pma-voice scale', () => {
    expect(speakerVolume()).toBe(30);
    convars.mica_speaker_volume = 400;
    expect(speakerVolume()).toBe(100);
    convars.mica_speaker_volume = -5;
    expect(speakerVolume()).toBe(1);
  });
});

describe('with nobody on speaker', () => {
  it('a tick reads nobody', () => {
    speakerReleaseAll();
    const coords = vi.fn();
    (globalThis as any).GetEntityCoords = coords;
    tickSpeakers(calls);
    expect(coords).not.toHaveBeenCalled();
  });
});
