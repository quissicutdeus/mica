import { Database } from './Database';
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

/** `charinfo` as both cores store it: a JSON column on `players`. */
const nameFromCharinfo = (charinfo: unknown): string | null => {
  if (!charinfo || typeof charinfo !== 'object') return null;
  const info = charinfo as Record<string, unknown>;
  const first = typeof info.firstname === 'string' ? info.firstname : '';
  const last = typeof info.lastname === 'string' ? info.lastname : '';
  const name = `${first} ${last}`.trim();
  return name.length > 0 ? name : null;
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

  const row = await Database.single<{ citizenid: string; charinfo: unknown }>(
    `SELECT citizenid, charinfo FROM players
     WHERE JSON_UNQUOTE(JSON_EXTRACT(charinfo, '$.phone')) = ?
     LIMIT 1`,
    [phone]
  );
  if (!row?.citizenid) return null;

  return {
    citizenid: row.citizenid,
    displayName: nameFromCharinfo(parseCharinfo(row.charinfo)),
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

  const row = await Database.single<{ citizenid: string; charinfo: unknown }>(
    'SELECT citizenid, charinfo FROM players WHERE citizenid = ? LIMIT 1',
    [citizenid]
  );
  if (!row?.citizenid) return null;

  const charinfo = parseCharinfo(row.charinfo);
  return {
    citizenid: row.citizenid,
    displayName: nameFromCharinfo(charinfo),
    phone:
      charinfo && typeof (charinfo as Record<string, unknown>).phone === 'string'
        ? ((charinfo as Record<string, unknown>).phone as string)
        : null
  };
}

/**
 * `charinfo` comes back as a string from some drivers and an object from others, depending on
 * whether the column is `json` or `text` and on how oxmysql was configured. Both shapes reach
 * here, so both are handled rather than one being assumed — the same reason `Photos` coerces
 * its `image` column on the way out.
 */
const parseCharinfo = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
