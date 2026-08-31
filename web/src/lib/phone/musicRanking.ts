/**
 * The rules that decide whose music you hear. MICA-111 phase 2, MICA-181.
 *
 * Pure, and deliberately separate from `shell/state/nearbyMusic.ts`: the state module owns
 * stores and persisted settings, and neither of those belongs in a test that wants to ask
 * a question about the rule without standing up a phone.
 *
 * ## Why this is phone-owned
 *
 * It lived in `sdk/lib/musicBroadcast.ts` until MICA-181, alongside
 * `MAX_AUDIBLE_BROADCASTS`, and the shell reached across the package boundary by relative
 * path to get at it. Splitting the module was the answer rather than publishing it,
 * because the two halves failed the same test differently: the cap has an importer inside
 * `@gphone/sdk` (`sdk/host/iframe/facets/music.ts`, which offers it to an add-on as
 * `useMusic().maxAudibleBroadcasts`) and stayed, at `sdk/host/seam/music.ts`. Everything
 * here had **no importer in the SDK at all** — only `shell/state/nearbyMusic.ts` and its
 * suite — so it is the shell's ranking, and it belongs on the shell's side.
 *
 * That is what makes it phone-owned in the sense `lib/ownership.test.ts` means: an add-on
 * cannot name it, the SDK does not reach it, and nothing published depends on it. Rule 3
 * in that file is what keeps the second of those true.
 *
 * Nothing in this file knows what a YouTube id is or what an iframe costs. It answers two
 * questions and no others: **which broadcasts win the cap**, and **where a source that
 * started before you arrived should start from**.
 */
import { MAX_AUDIBLE_BROADCASTS } from '../../../../sdk/host/seam/music';

/**
 * How much louder a challenger must be before it takes an incumbent's slot.
 *
 * **This is the anti-thrash rule and it is not optional.** The ranking input is a volume
 * the game client recomputes on a distance tick, so two people standing near each other
 * produce two numbers that cross and re-cross several times a second. Without a margin,
 * the pair at the cap boundary would swap slots on every tick — and a slot change is not a
 * cheap re-render, it is an iframe destroyed and a YouTube player created, which is audible
 * as stutter and expensive as work.
 *
 * 0.05 of a 0..1 range: large enough that ordinary jitter cannot cross it, small enough
 * that someone genuinely walking closer overtakes within a step or two.
 */
export const INCUMBENT_MARGIN = 0.05;

/**
 * How far back a join is allowed to seek, in seconds.
 *
 * A day. Not a guess at how long a track is — the phone never learns a remote track's
 * duration — but a bound on the arithmetic: `startedAt` is a clock the NUI did not set, and
 * a stale or skewed one would otherwise produce a `start` parameter of some arbitrary size.
 * Anything past the end of the video is YouTube's problem to clamp, and it does.
 */
const MAX_JOIN_OFFSET = 24 * 60 * 60;

/**
 * Where to start a source that began before you could hear it.
 *
 * The sync model in one line: the server holds the start time, and a client entering range
 * seeks to `now - startedAt` (MICA-111). Drift over a long track is tolerated on purpose
 * — a clock-sync protocol is not worth writing for music, and the ticket says so.
 *
 * Negative is clamped to zero rather than rejected: a server clock a second or two ahead of
 * the NUI's is normal, and "start at the beginning" is the right answer to it. A source
 * with no start time at all is also zero, which is what makes this safe to call on a
 * payload that came off the wire.
 */
export function joinOffsetSeconds(startedAt: number, now: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  const elapsed = Math.floor((now - startedAt) / 1000);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(elapsed, MAX_JOIN_OFFSET);
}

/**
 * Which broadcasts win the cap, in order, loudest first.
 *
 * **The winner rule, stated once and here: nearest wins.** The phone has no coordinates —
 * by contract the server pushes who is playing and the game client pushes a volume it has
 * already attenuated for distance — so the volume *is* the distance, inverted, and ranking
 * by it ranks by proximity without the NUI ever learning where anybody is standing.
 *
 * Everything about the ordering is written down rather than left to emerge:
 *
 * - **A tie is broken by token**, ascending. Two broadcasters at exactly the same range
 *   must not swap places because one of them happened to arrive earlier in an array;
 *   `sort` is stable in every engine we run on, and relying on that would be relying on
 *   the input order, which is the server's iteration order and nobody's decision.
 * - **An incumbent is ranked with `INCUMBENT_MARGIN` added**, so it keeps the slot it has
 *   unless genuinely overtaken. The bonus is applied to the *ranking* only; the volume
 *   handed back is the true one, because a broadcast must not get louder for having been
 *   audible a moment ago.
 *
 *   The caller passes an **empty** incumbent set to switch that off, and must, for any
 *   change that is a decision rather than distance — a mute, an unmute, an arrival. See
 *   `recompute` in `shell/state/nearbyMusic.ts`: an unmuted broadcaster who is genuinely
 *   nearer has to displace, and losing to a 0.05 bonus would read as the unmute not
 *   having worked.
 * - **Silence is not a candidate.** A volume of zero means the game client has said this
 *   one is out of earshot, and an id the client has not mentioned at all is treated the
 *   same way — the absence of a volume is not permission to play at full.
 *
 * Muting is applied by the caller, before this is reached, and that ordering is the point:
 * a muted broadcaster is not a loser of the cap, it is not a candidate for it. Muting the
 * nearest person is therefore how you hear the next one, which is what somebody muting
 * expects and would not get if a mute left its slot occupied.
 */
export function rankAudible<T extends { token: string }>(
  candidates: readonly T[],
  volumeOf: (candidate: T) => number,
  incumbents: ReadonlySet<string>,
  max: number = MAX_AUDIBLE_BROADCASTS
): T[] {
  return candidates
    .map((candidate) => {
      const volume = volumeOf(candidate);
      return {
        candidate,
        score: volume + (incumbents.has(candidate.token) ? INCUMBENT_MARGIN : 0),
        volume
      };
    })
    .filter(({ volume }) => volume > 0)
    .sort((a, b) => b.score - a.score || (a.candidate.token < b.candidate.token ? -1 : 1))
    .slice(0, Math.max(0, max))
    .map(({ candidate }) => candidate);
}
