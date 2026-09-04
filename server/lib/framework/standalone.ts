// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { citizenIdFromIdentifier, describeIdentifierRejection } from '@mica/shared/framework';
import { Database } from '../Database';
import { numberFor, readCitizenIdByNumber, readNumber, PHONE_NUMBERS_TABLE } from '../phoneNumbers';
import {
  exposes,
  offlineLookup,
  removeInventoryItem,
  resource,
  unidentified,
  type FrameworkAdapter,
  type FrameworkIdentity,
  type FrameworkPlayer
} from './runtime';

/* ──────────────────────────────────────────────────────────────────────────────
 * Standalone (no framework at all)
 *
 * The fourth adapter, and the first with nothing behind it. Everything below exists so a
 * server running micaOS and nothing else reaches the rest of this file as the qb-shaped
 * object it already knows how to read — the same trick the ESX section plays, with a
 * runtime that supplies an identity and nothing else.
 *
 * The blocker was one line: `ServiceEndpoint` refuses every action of every service when
 * `getPlayer` answers null, so with no framework the whole phone is inert. Answering here
 * unblocks all of it at once, and answering *honestly* — refusing money, degrading
 * metadata — is what keeps that from becoming a lie further down.
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * The convar that turns standalone on, and why it is a convar rather than a deduction.
 *
 * **Standalone is never inferred from the absence of a framework**, because absence is not
 * something this code can observe. `exposes` swallows the throw FiveM's `exports` proxy
 * raises for a resource that has not started yet (see its own note, and `detectFramework`),
 * so "es_extended is three lines further down server.cfg" and "there is no framework here"
 * are the same answer to a probe, and micaOS's own `onResourceStart` fires inside exactly
 * that window. A server that auto-detected standalone would key that boot's rows on a
 * license identifier and the next boot's on a citizenid — one player, two phones, and no
 * error anywhere.
 *
 * An operator saying so cannot be raced. It is one line in `server.cfg` and it is the whole
 * opt-in.
 */
export const STANDALONE_CONVAR = 'mica_standalone';

/**
 * What counts as on and off, and why a third bucket exists.
 *
 * `GetConvar` hands back a free-form string with no validation of its own — the fact
 * `orphanSweep.ts`'s `resolveOwnerOverride` documents at length for the convar that decides
 * which rows a sweep may delete. A value that is neither is **not** silently read as either:
 * `setr mica_standalone yes-please` is an operator who meant to enable this and has not,
 * and the difference between that and a working phone is one console line they can act on.
 */
const STANDALONE_ON = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const STANDALONE_OFF = new Set(['', '0', 'false', 'no', 'off', 'disabled']);

/**
 * The one-shot flags for this adapter, and why each is a module-level boolean rather than a
 * `Set<number>`.
 *
 * Every one of them reports a property of the **server**, not of a player: there is no
 * framework, so there is no money, no metadata sink and no usable-item registrar, and that
 * is equally true for everyone connected. `esxMetaUnsupportedReported` records the same
 * reasoning and the mistake it replaced — a per-source set grows for the life of the
 * resource and, because FiveM recycles server ids, silences a recycled id for whoever is
 * assigned it next.
 */
let standaloneConvarReported = false;
let standaloneConflictReported = false;
let standaloneMoneyReported = false;
let standaloneMetaReported = false;
let standaloneUsableItemReported = false;

/** Test seam, like `__resetEsxMetaWarning`. Clears every once-per-resource-start flag above. */
export const __resetStandaloneWarnings = (): void => {
  standaloneConvarReported = false;
  standaloneConflictReported = false;
  standaloneMoneyReported = false;
  standaloneMetaReported = false;
  standaloneUsableItemReported = false;
};

/** Has the operator asked for standalone? Says so once when the value is unreadable. */
const standaloneRequested = (): boolean => {
  let raw: string;
  try {
    // `typeof` rather than a bare reference: an absent native must read as "not requested"
    // rather than throw on a path `getPlayer` walks for every request.
    raw = typeof GetConvar === 'function' ? String(GetConvar(STANDALONE_CONVAR, '')) : '';
  } catch {
    return false;
  }

  const value = raw.trim().toLowerCase();
  if (STANDALONE_ON.has(value)) return true;
  if (STANDALONE_OFF.has(value)) return false;

  if (!standaloneConvarReported) {
    standaloneConvarReported = true;
    console.warn(
      `[FrameworkBridge] ${STANDALONE_CONVAR} is set to '${raw}', which is neither on nor ` +
        `off. Reading it as off, so micaOS is still waiting for a framework. Set it to '1' ` +
        `(or true/yes/on) to run micaOS with no framework at all. Reported once per ` +
        `resource start.`
    );
  }
  return false;
};

/**
 * The convar is set **and** a real framework answered. Refuse standalone, loudly.
 *
 * Silently preferring either one is the failure this exists to prevent, and the two
 * preferences fail differently rather than one being safe. Preferring standalone re-keys
 * every row from a citizenid onto a license identifier, so a live server's players lose
 * every note, contact and message they own — a data migration performed by a typo.
 * Preferring the framework without saying so leaves an operator who believes they are
 * running standalone with a phone that works for reasons they do not understand, and a
 * `server.cfg` line that does nothing.
 *
 * So the framework wins, because it is the one holding the rows that already exist, and the
 * console says which line to delete. Once per resource start, for the reason above the flags.
 */
export const reportStandaloneConflict = (framework: 'qb' | 'esx'): void => {
  if (standaloneConflictReported) return;
  standaloneConflictReported = true;
  const core = framework === 'qb' ? 'a qb core' : 'es_extended';
  const kept = framework === 'qb' ? 'qb' : 'ESX';
  console.error(
    `[FrameworkBridge] ${STANDALONE_CONVAR} is set, but ${core} is running on this server. ` +
      `Ignoring the convar and keeping ${kept} — it owns the identity every existing micaOS ` +
      `row is keyed on, and switching that is a data migration rather than a fallback. ` +
      `Remove '${STANDALONE_CONVAR}' from server.cfg, or remove the framework, so this ` +
      `server has one answer. Reported once per resource start.`
  );
};

/**
 * A player's `license:` identifier, which is the whole of their identity in standalone.
 *
 * `GetPlayerIdentifierByType` is the direct route and is what every modern FXServer has.
 * The scan over the numbered identifiers is the fallback for a build without it — the same
 * "try the accessor, then the table behind it" shape `esxVariable` uses, and for the same
 * reason: picking one and being wrong renders every player unidentifiable, silently.
 *
 * **`license:` specifically, not the first identifier that comes back.** `steam:` is absent
 * for anyone playing without Steam, `ip:` changes, and a `discord:` link can be revoked —
 * any of those as the key would hand a returning player a fresh, empty phone. Every FiveM
 * client has a license and keeps it.
 *
 * The identifier goes through `citizenIdFromIdentifier` at every call site rather than here,
 * so that one mapping in `shared/framework.ts` still decides what a citizenid is — including
 * its refusal to truncate an over-length one, which that file explains at length.
 */
const standaloneIdentifier = (src: number): string | null => {
  const player = String(src);

  try {
    if (typeof GetPlayerIdentifierByType === 'function') {
      const direct = GetPlayerIdentifierByType(player, 'license');
      if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
    }
  } catch {
    // An FXServer build without the native, or a source that has just dropped.
  }

  try {
    if (
      typeof GetNumPlayerIdentifiers === 'function' &&
      typeof GetPlayerIdentifier === 'function'
    ) {
      const count = GetNumPlayerIdentifiers(player);
      for (let index = 0; index < count; index++) {
        const identifier = GetPlayerIdentifier(player, index);
        if (typeof identifier === 'string' && identifier.startsWith('license:')) {
          return identifier.trim();
        }
      }
    }
  } catch {
    // Same.
  }

  return null;
};

/**
 * `charinfo`, as the rest of the server expects to find it — built from the only name a
 * frameworkless server has.
 *
 * `GetPlayerName` is the client's own display name. It is not a character name and this does
 * not pretend otherwise; it is what `PlayerDirectory`, `Messages` and `Music` render, and a
 * real name beats a blank one. Split on the first space exactly as `esxCharinfo` does with
 * `getName()`, so a two-word name lands in the two fields those readers expect.
 *
 * **`phone` comes from micaOS's own table**, because nothing in the FiveM runtime has a phone
 * number to offer and no framework is here to have issued one. `lib/phoneNumbers.ts` owns
 * that decision and the cache this reads; `services/PhoneNumbers.ts` owns the table and
 * assigns a number once, at connect. Null until that has happened, which every reader of
 * `charinfo.phone` already handles.
 */
const standaloneCharinfo = (
  src: number,
  citizenid: string
): { firstname: string; lastname: string; phone: string | null } => {
  let full: string | null = null;
  try {
    full = typeof GetPlayerName === 'function' ? GetPlayerName(String(src))?.trim() || null : null;
  } catch {
    full = null;
  }

  const space = full ? full.indexOf(' ') : -1;

  return {
    firstname: !full ? '' : space === -1 ? full : full.slice(0, space),
    lastname: !full || space === -1 ? '' : full.slice(space + 1).trim(),
    phone: numberFor(citizenid)
  };
};

/**
 * A standalone player wearing the qb shape, for the same reason `esxView` exists: five
 * callers outside this file read `PlayerData.citizenid` or `PlayerData.charinfo` off
 * whatever `getAllPlayers` returns, and three more read them off `rawPlayer`. Normalising
 * once, here, is what keeps the adapter inside `FrameworkBridge`.
 *
 * There is no framework object to keep alongside it — the `.xPlayer` slot ESX's view carries
 * has no twin here, because there is nothing to carry.
 */
const standaloneView = (citizenid: string, src: number) => ({
  PlayerData: {
    citizenid,
    source: src,
    charinfo: standaloneCharinfo(src, citizenid),
    metadata: undefined
  }
});

/**
 * Say once that money was asked for and there is none.
 *
 * Deliberately **not** routed through `moved`/`balanceOf`, which log an error every time.
 * Those exist to catch a framework whose contract changed under us, and they shout because
 * that is a surprise worth investigating. This is not a surprise: it is the permanent,
 * documented state of a server with no framework, and an error per call would be noise that
 * teaches an operator to ignore the log.
 */
const reportStandaloneMoney = (call: string, src: number): void => {
  if (standaloneMoneyReported) return;
  standaloneMoneyReported = true;
  console.warn(
    `[FrameworkBridge] ${call} was called for source ${src} and this server is running ` +
      `standalone, which has no money of any kind. Refusing — every balance reads as ` +
      `unaffordable and no transfer is ever reported as completed. An app that needs money ` +
      `should be hidden on this server. Reported once per resource start.`
  );
};

/**
 * `setMeta` **degrades, and says so once**, exactly as `esxSetMeta` does and for exactly the
 * same reason.
 *
 * The only caller is `Battery.ts`, mirroring the charge onto the framework player for the
 * benefit of *other* resources. micaOS's own source of truth is its `mica_battery` table,
 * which is written either way — so a dropped mirror costs a third-party integration and
 * never the phone. On standalone there is no framework player to mirror onto and no third
 * party to read it, which makes this a no-op with a receipt rather than a failure.
 */
const standaloneSetMeta = (src: number, key: string): void => {
  if (standaloneMetaReported) return;
  standaloneMetaReported = true;
  console.warn(
    `[FrameworkBridge] This server is running standalone, so there is no framework player to ` +
      `mirror metadata onto — '${key}' was dropped, first seen for source ${src}. micaOS's ` +
      `own tables are unaffected. Reported once per resource start, because this is a ` +
      `property of the server rather than of a player.`
  );
};

/** A standalone player as a `FrameworkPlayer`, or null when they cannot be identified. */
const standaloneFrameworkPlayer = (src: number): FrameworkPlayer | null => {
  const identifier = standaloneIdentifier(src);
  const citizenid = citizenIdFromIdentifier(identifier);
  if (!citizenid) {
    return unidentified(src, 'standalone', describeIdentifierRejection(identifier));
  }

  const view = standaloneView(citizenid, src);

  return {
    citizenid,
    source: src,
    phone: view.PlayerData.charinfo.phone ?? undefined,
    /**
     * Fail closed, all three. `-Infinity` is the sentinel `balanceOf` documents: every caller
     * asks `balance < amount`, and a balance that cannot be afforded for *any* amount lands
     * the refusal at the existing insufficient-funds branch rather than somewhere new.
     * `removeMoney` and `addMoney` answer false for the reason `moved` gives — the only safe
     * reading of "this cannot tell whether the money moved" is that it did not, because
     * guessing the other way invents currency.
     */
    getMoney: (type: 'bank' | 'cash') => {
      reportStandaloneMoney(`getMoney('${type}')`, src);
      return -Infinity;
    },
    removeMoney: (type: 'bank' | 'cash') => {
      reportStandaloneMoney(`removeMoney('${type}')`, src);
      return false;
    },
    addMoney: (type: 'bank' | 'cash') => {
      reportStandaloneMoney(`addMoney('${type}')`, src);
      return false;
    },
    setMeta: (key: string) => standaloneSetMeta(src, key),
    // Straight to the shared helper, which tries ox_inventory and then fail-opens with a
    // warning. That policy is stated where it lives and is not changed by there being no
    // framework: a consumable whose effect has already happened is not worth refusing over.
    removeItem: (item: string, count: number) => removeInventoryItem(src, {}, item, count),
    rawPlayer: view
  };
};

/**
 * Every connected player, keyed by source, in the qb shape.
 *
 * `GetNumPlayerIndices`/`GetPlayerFromIndex` rather than the `GetPlayers()` helper: that pair
 * are declared natives on `@citizenfx/server` and present on every build, while the helper is
 * a runtime convenience with no typing behind it.
 *
 * **Never lists a player it cannot name**, which is `esxAllPlayers`'s rule and
 * `unidentified`'s reasoning: an entry here reaches `proximity` and `pushMany` as a real
 * recipient, and a nameless one would be somebody else's mail.
 */
const standaloneAllPlayers = (): Record<number, unknown> => {
  const out: Record<number, unknown> = {};
  if (typeof GetNumPlayerIndices !== 'function' || typeof GetPlayerFromIndex !== 'function') {
    return out;
  }

  const count = GetNumPlayerIndices();
  for (let index = 0; index < count; index++) {
    const src = Number(GetPlayerFromIndex(index));
    if (!Number.isFinite(src) || src <= 0) continue;
    const citizenid = citizenIdFromIdentifier(standaloneIdentifier(src));
    if (!citizenid) continue;
    out[src] = standaloneView(citizenid, src);
  }
  return out;
};

/**
 * Register a usable item with whatever is here to register one — which may be nothing.
 *
 * There is no `CreateUseableItem` without a framework. ox_inventory is the one inventory
 * common enough on a frameworkless server to be worth asking, and it is asked through
 * `exposes` so a build without it is an answer rather than a throw.
 *
 * Otherwise this is a no-op **with one line saying what the operator loses**: the item
 * exists, players can hold it, and using it will not open the phone. Every other way of
 * opening the phone still works. Silence here would be indistinguishable from a registration
 * that succeeded, which is the failure shape this repo cares most about.
 */
const standaloneRegisterUsableItem = (item: string, cb: (source: number) => void): void => {
  for (const key of ['RegisterUsableItem', 'CreateUseableItem']) {
    if (exposes('ox_inventory', key)) {
      resource('ox_inventory')[key](item, cb);
      return;
    }
  }

  if (standaloneUsableItemReported) return;
  standaloneUsableItemReported = true;
  console.warn(
    `[FrameworkBridge] This server is running standalone and no inventory resource exposes a ` +
      `usable-item registration, so '${item}' is not registered as usable — using the item in ` +
      `an inventory will not open the phone. Reported once per resource start.`
  );
};

/**
 * The framework's own table of characters, and the column in it that holds what micaOS
 * stores as a `citizenid`.
 *
 * micaOS creates neither. qb owns `players(citizenid)`; es_extended owns
 * `users(identifier)`, which MICA-150 decided maps directly onto `citizenid` — one phone
 * per player rather than per character, recorded on that ticket.
 *
 * **Both fields are interpolated into SQL as identifiers, so both are frozen literals in
 * this module and nothing else may supply one.** MySQL cannot parameterize a table or a
 * column name (§2.9), and the only safe way to build such a statement is from a closed set
 * the server author wrote. `orphanSweep.ts` re-checks what it gets back before it builds
 * anything, on the principle that a guard which lives only at the producer stops guarding
 * the moment a second producer appears.

/**
 * The offline record on a server whose only record is micaOS's own.
 *
 * There is no `players` and no `users` to read, but there *is* a number, because
 * `services/PhoneNumbers.ts` issued it. The name is null and stays null, deliberately:
 * `GetPlayerName` answers only for a connected client and this lookup exists precisely for
 * players who are not, so inventing a name from the last one seen would be a cache pretending
 * to be a record. An offline standalone player renders as a number without a name, which is
 * what a phone with an unknown contact does anyway.
 *
 * Null when they have no number: a citizenid micaOS has never issued a number to is a player
 * micaOS has no record of at all.
 */
const findOfflineByCitizenId = async (citizenid: string): Promise<FrameworkIdentity | null> =>
  await offlineLookup('the standalone phone-number lookup by citizenid', async () => {
    const phone = await readNumber(citizenid);
    if (!phone) return null;
    return { citizenid, firstname: null, lastname: null, phone };
  });

/** The same, for many, in one `IN (…)` (MICA-197). */
const findOfflineByCitizenIds = async (
  citizenids: readonly string[]
): Promise<Map<string, FrameworkIdentity>> => {
  const found = new Map<string, FrameworkIdentity>();
  const placeholders = citizenids.map(() => '?').join(', ');

  await offlineLookup('the standalone phone-number lookup by citizenid', async () => {
    const rows = await Database.query<{ citizenid: string; number: string }[]>(
      `SELECT \`citizenid\`, \`number\` FROM \`${PHONE_NUMBERS_TABLE}\`
       WHERE \`citizenid\` IN (${placeholders})`,
      [...citizenids]
    );
    for (const row of rows) {
      if (!row?.citizenid) continue;
      found.set(row.citizenid, {
        citizenid: row.citizenid,
        firstname: null,
        lastname: null,
        phone: row.number ?? null
      });
    }
    return null;
  });

  return found;
};

/**
 * The standalone adapter.
 *
 * **`detect` is the operator's convar and nothing else.** Standalone is never inferred from
 * the absence of a framework, for the reason `STANDALONE_CONVAR` gives at length: `exposes`
 * cannot tell a resource that is missing from one that has not started yet, and a server that
 * auto-detected standalone would key one boot's rows on a license identifier and the next
 * boot's on a citizenid. The conflict case — the convar set *and* a framework running — is
 * settled by `detectFramework`, which asks the framework adapters first.
 */
export const standaloneAdapter: FrameworkAdapter = {
  kind: 'standalone',

  detect: standaloneRequested,

  /**
   * Both true, and both still gated by `FrameworkBridge` asking `detectFramework` first.
   *
   * A convar set beside a running framework is a misconfiguration the framework wins,
   * not a fallback — so "the operator asked for standalone" is not on its own enough to
   * serve a call. The bridge checks the verdict before it reaches this adapter, exactly
   * as the `detectFramework() === 'standalone'` guard at the end of each old branch
   * chain did.
   */
  canGetPlayer: () => true,
  canListPlayers: () => true,

  getPlayer: (src) => standaloneFrameworkPlayer(src),

  // Normalised into the qb shape by `standaloneView`, exactly as ESX's are, so the callers of
  // this outside the framework directory need no framework check of their own.
  getAllPlayers: standaloneAllPlayers,

  /**
   * **No character table at all** — micaOS is the only thing that knows a player exists — so
   * there is nothing for the orphan sweep to compare a citizenid against and it must skip.
   * That `null` means "there is nothing here to tell", which a caller must treat exactly as it
   * treats `unknown`'s "I cannot tell yet": never as "there are no characters".
   */
  ownerTable: () => null,

  findOfflineByCitizenId,
  findOfflineByCitizenIds,

  /**
   * **Standalone can answer this, and it is the only framework that can answer it well.**
   * micaOS issued the number itself, so the reverse lookup is a query against a table it owns
   * rather than a guess at somebody else's schema — which is exactly why ESX cannot. This is
   * what lets a standalone player start a conversation with, or dial, somebody offline.
   */
  findOfflineByPhone: async (phone) =>
    await offlineLookup('the standalone phone-number lookup by number', async () => {
      const citizenid = await readCitizenIdByNumber(phone);
      if (!citizenid) return null;
      return { citizenid, firstname: null, lastname: null, phone };
    }),

  registerUsableItem: (item, cb) => {
    standaloneRegisterUsableItem(item, cb);
    // Always "handled": `standaloneRegisterUsableItem` either registers through ox_inventory
    // or says once what the operator loses. Returning false would make `FrameworkBridge` fall
    // through to nothing, which is the silence that reads as success.
    return true;
  }
};
