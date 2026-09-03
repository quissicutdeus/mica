// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { call } from '../nui/call';
import { shellContract } from '@gos/shared/contracts/shell';
import { isBrowser } from '@gos/sdk';
import { ALL_CAPABILITIES, type AppCapability } from '../../../sdk/manifest';
import type { CapabilitySet } from '../lib/phone/appVisibility';

/**
 * `isBrowser()` answers `false` with no `window` at all since MICA-177, which is what
 * this module needs: `shell/state/registry.ts` imports it, and eight node-environment
 * suites load `registry.ts`, so a module-scope read here has to survive a test module
 * graph. It used to carry its own `typeof window` guard for that; the predicate now
 * answers the same thing for the same reason, in one place.
 */
const inPlainBrowser = (): boolean => isBrowser();

/**
 * What the server behind this phone can actually do, as the server itself reports it.
 *
 * The sibling of `admin.ts`, and built the same way on purpose: one store holding a
 * server-answered fact that decides what the UI shows, asked once at boot and re-asked
 * whenever the character behind the phone changes. See that file for why a single store
 * beats each screen asking for itself.
 *
 * It decides visibility and nothing more. `AppManifest.requires` says so in as many words
 * and it is worth repeating here, next to the code: the server refuses every action it
 * would have refused anyway (AGENTS.md §2.9), and a modified client can emit whatever it
 * likes. Hiding an app whose capability is missing spares the player a Bank that always
 * errors; it is not what stops them moving money.
 *
 * `CapabilitySet` itself lives in `lib/appVisibility.ts` with the rule that reads it —
 * that module has to stay free of anything touching `window`, and this one does not.
 */
export type { CapabilitySet } from '../lib/phone/appVisibility';

const uniform = (value: boolean): CapabilitySet =>
  Object.fromEntries(ALL_CAPABILITIES.map((name) => [name, value]));

/**
 * Every capability, present or absent.
 *
 * **In game it starts denied, and that is the deliberate direction.** The alternative —
 * assume the framework is there until the server says otherwise — would mean a missing
 * `checkCapabilities` layer looked exactly like a healthy framework server: Bank and Hodlr
 * on the launcher, standalone mode silently ungated, and nothing in any suite to notice
 * (AGENTS.md §8). Denied-until-answered fails the other way, loudly and visibly, which is
 * the failure this repo would rather have.
 *
 * The cost of that direction is a beat where the two money apps are absent, so the answer
 * is put in flight at `Shell.svelte`'s mount — resource start, with the phone still closed
 * — rather than waiting for `bootstrapStores` to run on first open. Same reasoning, and
 * the same fix, as `loadRemoteAppConfig` there.
 *
 * A plain browser has no framework to ask about and its mock transport always has money,
 * so it stands in as fully capable — exactly what `admin.ts` does with `isBrowser()`. The
 * request still goes out there: the browser mock is what answers it, so a mock that goes
 * missing flips these to `false` and takes Bank off the dev launcher instead of quietly
 * papering over the gap.
 */
export const capabilities = writable<CapabilitySet>(uniform(inPlainBrowser()));

/**
 * Whether the answer above is the server's or still the starting assumption.
 *
 * Two questions that a single boolean-per-capability cannot hold apart, because the safe
 * answer differs by caller. Hiding an icon while the reply is in flight costs a repaint,
 * so an unanswered capability reads as absent there. Refusing an *install* while the reply
 * is in flight would fail every saved add-on on the boot path that re-verifies them, so
 * `registry.ts` waits for a real answer before turning one away.
 */
export const capabilitiesKnown = writable(inPlainBrowser());

/**
 * In flight, so the mount-time ask and `bootstrapStores` collapse into one request.
 *
 * A promise rather than the `asked` boolean this and `admin.ts` both used to carry. That
 * latch never cleared, so `pushRehydrate` on a character switch re-ran the bootstrap and
 * got the previous character's answer back unchanged — the new character inherited their
 * icon visibility for the rest of the session. Nulling it on settle keeps the
 * de-duplication (concurrent callers share one request) without the memory.
 */
let inFlight: Promise<void> | null = null;

/** Ask the server what it can do. Safe to call from anywhere that needs the answer. */
export const refreshCapabilities = async (): Promise<void> => {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = (await call(shellContract, 'capabilities', undefined)) as Partial<
        Record<AppCapability, boolean>
      >;
      // Read through `ALL_CAPABILITIES` rather than trusting the reply's own keys: anything
      // short of an explicit `true` is a no, the same way `admin.ts` refuses to read
      // `'yes'` as a grant, and a capability the reply omits is simply absent.
      capabilities.set(
        Object.fromEntries(ALL_CAPABILITIES.map((name) => [name, res?.[name] === true]))
      );
      capabilitiesKnown.set(true);
    } catch {
      capabilities.set(uniform(false));
      capabilitiesKnown.set(true);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
};
