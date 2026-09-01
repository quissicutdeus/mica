// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

export { describeMusicError, reasonForCode } from '../../lib/musicErrors';

/**
 * What the two `useMusic` facet twins share, and the phone's half may name. MICA-181.
 *
 * `useMusic` is implemented twice — `sdk/host/iframe/facets/music.ts` for a sandboxed
 * add-on, and `web/src/host/facets/music.ts` in-process for the shell — and both hand the
 * app the same three pure things: `describeMusicError`, `reasonForCode` and the audible
 * cap. The iframe twin lives inside the package and imports them from `sdk/lib/`
 * directly. The in-process twin does not, and until this file it reached across the
 * package boundary by relative path into `sdk/lib/musicErrors` and `sdk/lib/musicBroadcast`
 * — two modules `@gphone/sdk` publishes from no entry point at all.
 *
 * So this is the seam, on the same terms as `captureZoom.ts` beside it: a value the
 * package hands the phone, in a directory the phone is already entitled to reach, named
 * once instead of the phone free-handing into a private implementation directory.
 * `lib/ownership.test.ts` rule 5 is what makes the difference enforceable.
 *
 * **Not published, and that is the decision.** `describeMusicError` and
 * `maxAudibleBroadcasts` are already part of what an app gets — `facets.ts` declares both
 * on the `music` facet — so an add-on can already call the one and read the other through
 * `useMusic()`. Adding bare names for them to `index.ts`/`addon.ts` would freeze two more
 * identifiers into `SDK_CONTRACT_VERSION` and disclose nothing an app did not already
 * have. `MusicError` and `MusicErrorReason` are the published half and travel on
 * `useMusic.ts`, where they already were.
 */

/**
 * How many other people's music plays at the same time.
 *
 * Three, and the number is a frame-budget decision rather than a taste one. Each audible
 * broadcast is a live cross-origin YouTube player decoding video (the frame is invisible,
 * not absent — `MusicFrame.svelte` says why it cannot be hidden outright) on a client that
 * is also rendering GTA. Uncapped, a busy street corner is however many players happen to
 * be standing in it, which is the way to kill a framerate that MICA-111 named before any
 * of this was written.
 *
 * Three rather than one because a bar with two people playing music is a real thing and
 * hearing only one of them is a worse lie than hearing both. Three rather than five
 * because nobody can pick four songs apart anyway.
 *
 * **This is the number to lower first** if an in-game test says four players at once (three
 * nearby plus your own) is too many. It is one line, and nothing else has to move.
 *
 * The division of labour with `@gphone/shared/musicBroadcast` is worth stating, because both have
 * a cap in them and they are not the same cap. The server's `MAX_NEARBY_BROADCASTS` bounds
 * the *roster* — how many people it will name to one listener — and it is a message-size
 * decision. This one bounds how many of those actually get a player, and it is a
 * frame-budget decision, made on the client because only the client knows the distances the
 * ranking depends on.
 *
 * It sits here rather than in `web/src/lib/phone/musicRanking.ts` with the ranking that
 * reads it, because the iframe twin needs it too and may import nothing from the phone.
 * That is the whole test MICA-181 applied to `lib/musicBroadcast.ts`: the ranking had no
 * importer inside the SDK and moved out; this constant had one and stayed.
 */
export const MAX_AUDIBLE_BROADCASTS = 3;
