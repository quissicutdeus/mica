// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from './FrameworkBridge';

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
    if (online) {
      return {
        citizenid: online.citizenid,
        displayName: nameFromCharinfo(online.rawPlayer?.PlayerData?.charinfo),
        phone: online.phone ?? null
      };
    }
  }

  const offline = await FrameworkBridge.findOfflineByCitizenId(citizenid);
  if (!offline) return null;

  return {
    citizenid: offline.citizenid,
    displayName: joinName(offline.firstname, offline.lastname),
    phone: offline.phone
  };
}
