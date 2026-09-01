// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge, type FrameworkIdentity, type FrameworkPlayer } from './FrameworkBridge';

/**
 * Who a citizenid belongs to, online or not.
 *
 * There was no such thing, and identity resolution had already forked because of it.
 * `FrameworkBridge` offers `getPlayerByPhone` and `getSourceByCitizenId`, both online-only.
 * Meanwhile `Conversations.ts` bypassed the bridge entirely: it called
 * `exports['qbx_core'].GetPlayerByPhone` directly, built a display name inline from
 * `charinfo`, and fell back to its own `JSON_EXTRACT` query. Two resolvers, one behind the
 * abstraction and one in front of it, free to disagree about who a phone number belongs to.
 *
 * Every social app needs this and none of them should write it again — a Blabber `@handle`
 * belongs to a player you have never met, so `useContacts` (your own address book) is exactly
 * the wrong primitive, and a post authored by someone offline still has to render a name.
 *
 * Deliberately **not cached**. The plan called for a short TTL; there is no hot path yet —
 * one lookup per conversation created — and a cache here would mean a renamed character
 * showing a stale name for as long as the TTL, which is a bug traded for nothing. Add one when
 * a caller makes it necessary, and it will be obvious which caller that was.
 *
 * Deliberately **no `gphone_profiles` table** yet either. Handles and avatars are Blabber's
 * requirement, and a table with no reader is the thing §7's ActionSheet note warns about.
 */

export interface DirectoryEntry {
  citizenid: string;
  /** `Firstname Lastname`, or null when the framework will not say. */
  displayName: string | null;
  phone: string | null;
}

/**
 * `Firstname Lastname`, or null when there is nothing to show.
 *
 * Null rather than a stray space: `${first} ${last}` on two empty strings is `" "`, which
 * renders as a blank name that looks like a rendering bug instead of like missing data.
 */
const joinName = (first: string | null, last: string | null): string | null => {
  const name = `${first ?? ''} ${last ?? ''}`.trim();
  return name.length > 0 ? name : null;
};

/**
 * `charinfo` as both qb cores store it: a JSON column on `players`, and the shape an ESX
 * `xPlayer` is normalised into by `FrameworkBridge`. Used for the **online** path only — the
 * offline path asks the bridge, which knows which table this server keeps players in.
 */
const nameFromCharinfo = (charinfo: unknown): string | null => {
  if (!charinfo || typeof charinfo !== 'object') return null;
  const info = charinfo as Record<string, unknown>;
  return joinName(
    typeof info.firstname === 'string' ? info.firstname : null,
    typeof info.lastname === 'string' ? info.lastname : null
  );
};

/**
 * The player holding this number, online or off.
 *
 * Online first, because the framework's in-memory character is authoritative for a loaded
 * player and a rename may not have been written back yet. Then one SQL read.
 *
 * Returns null rather than guessing. The code this replaces had a real defect worth naming: on
 * a framework object with no `PlayerData` it did `targetCitizenId = targetPlayer.phone_number`
 * — assigning a **phone number to a citizenid**. That value then went into
 * `gphone_messages_participants.citizenid`, which is a foreign key onto `players`, so the
 * write either failed or created a participant keyed to something that is not a person.
 */
export async function resolveByPhone(phone: string): Promise<DirectoryEntry | null> {
  if (!phone) return null;

  const online = FrameworkBridge.getPlayerByPhone(phone);
  if (online) {
    return {
      citizenid: online.citizenid,
      displayName: nameFromCharinfo(online.rawPlayer?.PlayerData?.charinfo),
      phone: online.phone ?? phone
    };
  }

  const offline = await FrameworkBridge.findOfflineByPhone(phone);
  if (!offline) return null;

  return {
    citizenid: offline.citizenid,
    displayName: joinName(offline.firstname, offline.lastname),
    phone
  };
}

/**
 * The two mappings, named once each.
 *
 * `resolve` and `resolveMany` differ in how many people they ask about and therefore in which
 * lookup they use — one `LIMIT 1` read against the framework's character table, or one
 * `IN (…)` over the same one. What they must **not** differ in is what an answer means, which
 * is the "two resolvers free to disagree" this file's own preamble was written about. So the
 * shape of an entry is decided here and nowhere else, and a change lands on both at once.
 */
const entryFromOnline = (online: FrameworkPlayer): DirectoryEntry => ({
  citizenid: online.citizenid,
  displayName: nameFromCharinfo(online.rawPlayer?.PlayerData?.charinfo),
  phone: online.phone ?? null
});

const entryFromIdentity = (identity: FrameworkIdentity): DirectoryEntry => ({
  citizenid: identity.citizenid,
  displayName: joinName(identity.firstname, identity.lastname),
  phone: identity.phone
});

/**
 * The player behind a citizenid, online or off.
 *
 * What a feed needs: a post's author is a citizenid, and rendering it requires a name whether
 * or not they happen to be connected.
 */
export async function resolve(citizenid: string): Promise<DirectoryEntry | null> {
  if (!citizenid) return null;

  const source = FrameworkBridge.getSourceByCitizenId(citizenid);
  if (source !== null) {
    const online = FrameworkBridge.getPlayer(source);
    if (online) return entryFromOnline(online);
  }

  const offline = await FrameworkBridge.findOfflineByCitizenId(citizenid);
  return offline ? entryFromIdentity(offline) : null;
}

/**
 * The same, for a list — in **one** query rather than one per name (MICA-197).
 *
 * The note at the top of this file says a cache would be a bug traded for nothing while there
 * was no hot path. There are two now, and neither wanted a cache: a leaderboard resolves ten
 * citizenids at once and a conversation list resolves every participant of every thread, and
 * both were paying a `LIMIT 1` round trip per person. Batching costs no freshness at all —
 * every answer is still read fresh, just together — which is why this is the shape that was
 * missing rather than the TTL that was declined.
 *
 * Online players are answered from the framework's own in-memory character and cost no query
 * at all. Everyone else goes into a single `findOfflineByCitizenIds`.
 *
 * **A source is only believed if the player on it agrees.** `getSourcesByCitizenId` answers
 * from a registry now, and a registry can be stale — so the citizenid the framework reports
 * for that source is checked against the one asked about, and a disagreement is treated as
 * "not connected" rather than as a name. Getting this wrong renders one player under
 * another's name, which is worse than rendering no name. `resolve` above needs no such check:
 * it asks the framework for the one source it was given and uses whatever came back, so there
 * is no second identity in play to be confused with.
 */
export async function resolveMany(
  citizenids: readonly string[]
): Promise<Map<string, DirectoryEntry>> {
  const found = new Map<string, DirectoryEntry>();

  const wanted = [...new Set(citizenids.filter(Boolean))];
  if (wanted.length === 0) return found;

  const sources = FrameworkBridge.getSourcesByCitizenId(wanted);
  const offline: string[] = [];

  for (const citizenid of wanted) {
    const source = sources.get(citizenid);
    const online = source === undefined ? null : FrameworkBridge.getPlayer(source);

    if (online && online.citizenid === citizenid) found.set(citizenid, entryFromOnline(online));
    else offline.push(citizenid);
  }

  if (offline.length === 0) return found;

  for (const [citizenid, identity] of await FrameworkBridge.findOfflineByCitizenIds(offline)) {
    found.set(citizenid, entryFromIdentity(identity));
  }

  return found;
}
