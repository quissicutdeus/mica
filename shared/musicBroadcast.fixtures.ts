// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NearbyBroadcast } from './musicBroadcast';

/**
 * One roster row, built in one place, for the tests on every hop that carries it.
 *
 * **Test-only.** Nothing in the resource imports this; it exists so the four layers a
 * proximity broadcast crosses stop describing it in four hand-rolled vocabularies.
 *
 * That is not a tidiness argument. MICA-111 phase 2 spent a whole exchange on a bug that
 * did not exist because the server's tests, the client hop's tests and the shell's tests
 * each built their own row: the shell renamed `id` to `token` and `name` to `label`, every
 * suite stayed green against its own fixture, and the disagreement was only visible to
 * `typecheck:web` and to somebody reading two files side by side. A shared fixture makes a
 * renamed field break every hop's tests at once, which is the moment it is cheapest to find.
 *
 * The defaults are a plain, playing, unpaused video broadcast — the case nearly every test
 * wants — and `overrides` is how a test says the one thing it is actually about. Spread
 * last, so a test can null out `videoId` for a playlist row or pin `startedAt` to a fixed
 * clock without the default winning.
 */
export const nearbyBroadcastFixture = (
  overrides: Partial<NearbyBroadcast> = {}
): NearbyBroadcast => ({
  source: 3,
  // Shaped like a real one — opaque, from the token alphabet — rather than 'TOKEN', so a
  // test that accidentally depends on it looking like a citizenid fails here.
  token: 'k3f9xq2wm7t1',
  label: 'Casey Doyle',
  videoId: 'dQw4w9WgXcQ',
  playlistId: null,
  startedAt: 0,
  paused: false,
  ...overrides
});

/**
 * Every field a row carries, derived from the fixture rather than listed again.
 *
 * A second hand-written list is a second thing to forget: the point of this one is that a
 * field added to `NearbyBroadcast` and to the fixture appears here for free, so a producer
 * asserting against it notices immediately that it is not sending the new field.
 */
export const nearbyBroadcastFields = (): string[] => Object.keys(nearbyBroadcastFixture()).sort();
