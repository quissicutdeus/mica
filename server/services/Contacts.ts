// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService, SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { Contact, SharedContactCard } from '@mica/shared/types';
import { guardNetEvent } from '../lib/netGuard';
import { findNearbyVisiblePlayers } from '../lib/proximity';
import { appEventChannel } from '../lib/appEvents';
import { contactsContract } from '@mica/shared/contracts/contacts';
import { s } from '@mica/shared/schema';
import { restoreWindowDays } from '../lib/retention';
import { phoneForCitizen } from '../lib/deviceIdentity';
import { defaultContacts } from '../lib/ownerConfig';
import { isRingtoneValue, MAX_OWNER_SOUND_ID } from '@mica/shared/ownerConfig';
import { onDeviceCreated } from './Devices';
import { PlayerFacingError } from '../lib/errors';
import { isDuplicateKey } from '../lib/sqlErrors';
import { who } from '../lib/who';
import { withoutOwnerKeys } from '../lib/replyShape';
import {
  BLIND_INDEX_WIDTH,
  blindIndexCandidates,
  blindIndexOf,
  openRow,
  openRows
} from '../lib/contentCipher';

import { contactNumberKey } from '../lib/contactNumbers';

/**
 * What a player is told when a write would give their phone a second live contact with one
 * number (MICA-335): `device_phone_unique` refused it. Without this the refusal was the generic
 * failure, which says nothing about what to change.
 */
const numberTaken = (): PlayerFacingError =>
  new PlayerFacingError('You already have a contact with that number.', {
    key: 'server.contacts.numberTaken'
  });

/**
 * The contacts table's repository: the generic path, with `device_phone_unique`'s refusal put
 * in words on every write a player makes, and the two writes the server makes on a player's
 * behalf.
 */
class ContactRepository extends SchemaRepository<Contact> {
  /**
   * The live contact on this phone with this number, by its blind index (MICA-432), or null.
   *
   * `device_phone_unique` refuses a second live row whose index is the same — which is every
   * row indexed under the same key. Between a key being enabled or rotated and the backfill, a
   * row can still carry an older key's index, or the `plain:` one, and the unique key cannot see
   * that the two are one number. So every write that could add one asks first, over every form
   * the index can take. A race inside that window is the one gap, and the backfill reports it.
   */
  async liveWithNumber(
    deviceId: unknown,
    phone: unknown,
    exceptId?: number | string
  ): Promise<number | null> {
    const entry = blindIndexOf(this.tableName, 'phone');
    if (!entry || typeof deviceId !== 'string' || deviceId === '' || typeof phone !== 'string') {
      return null;
    }
    const candidates = await blindIndexCandidates(entry, { device_id: deviceId }, phone);
    const found = await Database.scalar<number | string | null>(
      `SELECT \`id\` FROM \`${this.tableName}\` WHERE \`device_id\` = ? ` +
        `AND \`phone_key\` IN (${candidates.map(() => '?').join(', ')})` +
        (exceptId === undefined ? '' : ' AND `id` <> ?') +
        ' LIMIT 1',
      [deviceId, ...candidates, ...(exceptId === undefined ? [] : [exceptId])]
    );
    return found === null || found === undefined ? null : Number(found);
  }

  /** The generic create. A number the phone already has live is refused as `numberTaken`. */
  override async create(data: Partial<Contact>): Promise<number> {
    if ((await this.liveWithNumber(data.device_id, data.phone)) !== null) throw numberTaken();
    try {
      return await super.create(data);
    } catch (error) {
      throw isDuplicateKey(error) ? numberTaken() : error;
    }
  }

  /** The generic update: renumbering a contact onto a number another one holds live. */
  override async update(
    id: number | string,
    data: Partial<Contact>,
    citizenid: string,
    deviceId?: string
  ): Promise<boolean> {
    if (typeof data.phone === 'string') {
      const on = await Database.scalar<string | null>(
        `SELECT \`device_id\` FROM \`${this.tableName}\` WHERE \`id\` = ? AND \`citizenid\` = ?`,
        [id, citizenid]
      );
      if ((await this.liveWithNumber(on, data.phone, id)) !== null) throw numberTaken();
    }
    try {
      return await super.update(id, data, citizenid, deviceId);
    } catch (error) {
      throw isDuplicateKey(error) ? numberTaken() : error;
    }
  }

  /** Bringing a deleted contact back after its number was saved again. */
  override async restore(
    id: number | string,
    citizenid: string,
    windowDays: number,
    deviceId?: string
  ): Promise<boolean> {
    /**
     * Asked first, as create and update ask (MICA-432): a contact deleted while its index was
     * `plain:` or an older key's comes back beside a live one under the active key as two live
     * contacts for one number, which the unique key cannot see. The row's own phone and number,
     * opened, under the caller's ownership; a row that is not theirs reads as nothing here and
     * the restore below refuses it as before.
     */
    const row = await Database.single<{
      citizenid: string;
      device_id: string | null;
      phone: string;
    } | null>(
      'SELECT `citizenid`, `device_id`, `phone` FROM `mica_contacts` WHERE `id` = ? AND `citizenid` = ?',
      [id, citizenid]
    );
    if (row) {
      const opened = openRow('mica_contacts', row);
      if ((await this.liveWithNumber(opened.device_id, opened.phone, id)) !== null) {
        throw numberTaken();
      }
    }
    try {
      return await super.restore(id, citizenid, windowDays, deviceId);
    } catch (error) {
      throw isDuplicateKey(error) ? numberTaken() : error;
    }
  }

  /**
   * Insert a contact the server writes for a player, or answer `null` when the phone already
   * holds its number live. For the default-contacts seed and `AddContact`, where a number the
   * phone has is not a refusal but the contact already being there.
   */
  async insertUnlessHeld(data: Partial<Contact>): Promise<number | null> {
    if ((await this.liveWithNumber(data.device_id, data.phone)) !== null) return null;
    try {
      return await super.create(data);
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    }
  }

  /**
   * Onto the phone the citizen is on (MICA-282): their active one, or the one they used
   * last, or their identity phone — `phoneForCitizen` decides, and a row with no phone
   * would be one no phone ever shows.
   *
   * **A number the phone already has answers that contact's id** (MICA-335). A job that
   * hands its dispatch number out on every shift used to stack one copy per shift;
   * `device_phone_unique` now refuses the second, and the contact the export asked for is
   * there either way, so the export says so rather than failing. The existing row is left
   * as the player keeps it, name included.
   *
   * Found the way the key found it — by phone and `phone_key`, and by no citizen: a live row
   * there can still name the phone's previous holder while a handover is unwalked, and the key
   * refuses on it all the same. Server-internal, like the seed's read: the id is only answered
   * to the resource that asked, and the row is on the phone this citizen is on.
   */
  async addForPlayer(citizenid: string, item: Partial<Contact>): Promise<number> {
    const device_id = await phoneForCitizen(citizenid);
    const id = await this.insertUnlessHeld({ ...item, citizenid, device_id } as Partial<Contact>);
    if (id !== null) return id;
    // By the number's blind index (MICA-432), in every form it can take.
    const existing = await this.liveWithNumber(device_id, item.phone);
    if (existing === null) {
      // Refused, and gone by the time it was looked for: deleted in between. Not a contact to
      // point the caller at.
      throw new Error(`[contacts] ${this.tableName} refused a number it no longer holds.`);
    }
    return Number(existing);
  }
}

/**
 * Contacts: owner-scoped address book, all four generic CRUD actions.
 *
 * `phone` and `favorite` are the only filterable fields — the address-book UI
 * looks contacts up by number and filters the favourites list. Nothing else needs
 * to be, and every filterable column is one more thing a client can probe.
 */
export const contacts = defineService<Contact, typeof contactsContract>({
  id: 'contacts',
  contract: contactsContract,
  deviceOwned: true,
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'deleted', 'moderated'],
  /**
   * The name, number and email are sealed at rest (MICA-431, MICA-432), bound to the phone the
   * contact is on. The number is found by its blind index, `phone_index`.
   */
  encryptionScope: [],
  schema: {
    firstname: { type: 'string', length: 50, notNull: true, encrypted: true, versioned: true },
    lastname: { type: 'string', length: 50, encrypted: true, versioned: true },
    /**
     * Sealed (MICA-432), and found by its blind index, `phone_index`, scoped to the phone: one
     * number on two phones gives two unrelated indexes. Not filterable — a client finds a contact
     * by number in the list it already holds, opened.
     */
    phone: {
      type: 'string',
      length: 20,
      notNull: true,
      encrypted: true,
      blindIndex: { scope: ['device_id'], normalize: contactNumberKey },
      // What an edit replaces is kept (MICA-430).
      versioned: true
    },
    email: { type: 'string', length: 100, encrypted: true, versioned: true },
    /**
     * Base64 image data. Retyped from `mediumblob` and sealed (MICA-432): a sealed value is
     * text. ASCII, so a byte a character, as the photo bound is (MICA-431).
     */
    avatar: { type: 'mediumtext', encrypted: true, ascii: true },
    /**
     * Per-contact ringtone override (MICA-142): a built-in id or, since MICA-256, an owner
     * sound's `owner:<stem>`. A varchar as wide as the longest owner id rather than the enum
     * it was (`0005` retyped it), held to that shape by `isRingtoneValue` so a payload cannot
     * park arbitrary text here. Nullable, and no `default` — null means "use the system
     * ringtone" and must stay the default rather than being backfilled to `classic`; a
     * client clears the override by writing `null`, which `assertWritableValue` always
     * accepts ahead of the value check. Whether the owner's file still exists is the phone's
     * question: a removed sound falls back to the system ringtone when it plays.
     */
    ringtone: { type: 'string', length: MAX_OWNER_SOUND_ID, accepts: isRingtoneValue },
    favorite: { type: 'bool', default: 0, clientFilterable: true },
    /**
     * The owner's default this row was seeded from, by its number as the owner configured it
     * (MICA-335); `NULL` on every contact a player or a job saved. Never client-writable, so
     * it survives the player editing the contact's number — which is what lets a retried seed
     * tell "this default is here, renumbered" from "this default is missing" and not add the
     * original number a second time. Nullable and undefaulted, so the additive pass adds it with
     * every existing row `NULL`: an existing row is simply not known to be a seeded one, which
     * only a retry reads, and no existing phone owes one. `private`: no client reads it.
     */
    default_number: { type: 'string', length: 20, clientWritable: false, private: true },
    /**
     * The number's blind index while the row is `'active'`, `NULL` otherwise (`phone` itself
     * until MICA-432 sealed it): what `device_phone_unique`
     * constrains (MICA-335), so one phone holds at most one live contact per number and a
     * deleted or moderated one holds no slot. The technique, and the reasoning, are
     * `pair_key`'s in `Conversations.ts`: a unique key never collides on `NULL`.
     *
     * Over every status instead, `delete` being soft would wedge the number — deleting a
     * contact and saving its number again would be a duplicate-key error — and `'revive'`
     * cannot be declared here, since `firstname` is `NOT NULL` with no default.
     *
     * **`0014_private_lookups_get_blind_indexes` restates this expression**, frozen as it
     * shipped, as `0010_contact_numbers_unique_per_device` did the one before it: change it here
     * and a fresh install and an upgraded one disagree, which the planner cannot see (it compares
     * a generated column by name only). A change is a new migration.
     */
    phone_key: {
      type: 'string',
      length: BLIND_INDEX_WIDTH,
      clientWritable: false,
      private: true,
      generatedAs: "CASE WHEN `status` = 'active' THEN `phone_index` ELSE NULL END"
    }
  },
  indexes: [
    { name: 'citizenid_favorite', columns: ['citizenid', 'favorite', 'status'] },
    /**
     * One live contact per number on a phone (MICA-335). What closes the seed's race with a
     * player saving the same number between the seed's read and its insert: the second insert
     * is refused rather than written beside the first. The same number as `contactNumberKey`
     * compares it, not `sameNumberKey`'s digits — `555-0100` and `5550100` are still two rows,
     * as the player typed them.
     */
    { name: 'device_phone_unique', columns: ['device_id', 'phone_key'], unique: true }
  ],
  uniqueAfterDelete: {
    optOut:
      "`phone_key` is generated NULL on any row that is not 'active', so a deleted contact holds " +
      'no key and saving its number again is a plain insert; a restore that would make two ' +
      'live contacts share a number is refused by the key, as numberTaken.'
  },
  /**
   * `addForPlayer` is what makes the `AddContact` export possible — a job handing out a
   * dispatch number writes on the player's behalf, which the generic owner-scoped create
   * cannot do because there is no NUI request to scope it to. Same pattern as
   * `Photos.ts`'s `addForPlayer`: a named method rather than a service-level bypass (§2.9),
   * so the columns it sets are exactly the ones a contact needs and nothing wider opens up.
   */
  repositoryFactory: (resolved) => new ContactRepository(resolved)
});

const repo = contacts.repo as ContactRepository;

/**
 * What makes two contact numbers the same one: their digits, so `5550100` saved by the player
 * and a default of `555-0100` are one contact, not two side by side. This is the rule the
 * phone already uses to find the contact for a number — `contactRingtone` in
 * `web/src/shell/state/toast.ts`, matching a caller who arrives as `5550199` to a contact
 * saved as `555-0199` — mirrored here because a server module cannot import the shell. A
 * number with no digits at all is compared as written, trimmed, the way `phoneNumberFrom`
 * leaves it, rather than every such number being one key.
 */
const sameNumberKey = (number: string): string => number.replace(/\D/g, '') || number.trim();

/**
 * The owner's default contacts (`mica_default_contacts`, MICA-234), written into a phone the
 * moment this server first creates it and never again — see `onDeviceCreated` for why the
 * phone's own insert is the once-only mark. Onto that phone id directly rather than through
 * `addForPlayer`, whose `phoneForCitizen` could name a different phone the citizen holds.
 * A throw here is logged by `Devices.ts` and the phone is created regardless.
 *
 * **Idempotent, because a throw is retried** (MICA-327). Seeding is entry by entry, so a throw
 * on the third of five used to leave two and lose three for good. Now `Devices.ts` runs this
 * again on a later resolve of the phone, and each run writes only the entries the phone does
 * not have yet: a default is "there" when any row on this phone carries its number
 * (`sameNumberKey`), **in any status**. That is what keeps a retry from bringing back a
 * default the player deleted on purpose — `delete` is soft, so the deleted row still carries
 * the number — and from doubling one the first run wrote. A number the player already saved
 * themselves, in any format, counts as there too, which is the right answer: they have that
 * contact.
 *
 * Per entry rather than one transaction for the lot. A transaction would make a run all or
 * nothing, but the failed run still has to be run again, and something still has to say which
 * defaults a phone has; reading the rows answers that for both.
 *
 * **Each seeded row says which default it is** (`default_number`, MICA-335), and a default is
 * also "there" when a row says it is. The number a player can edit; that column they cannot.
 * So a seeded default the player renumbered before a retry is not added again under its
 * original number — which, since a restart no longer forgets the retry, can now be days later.
 *
 * **A duplicate-key refusal is "there" too.** `device_phone_unique` refuses an insert of a
 * number this phone already holds live, which is exactly a player saving the default's number,
 * as typed, between the read above and the insert here. Before the key that race wrote the
 * number twice; now the seed's insert loses it, and the player's row is the default.
 *
 * Server-internal and keyed on the phone alone, deliberately without a citizenid: the read
 * only decides what to insert, and rows on one phone all name its holder anyway.
 */
onDeviceCreated('defaultContacts', async (deviceId, citizenid, kind) => {
  // A phone's address book, not a tablet's (MICA-264): Contacts is phone-only, so defaults
  // seeded onto a tablet's id would be rows nothing can ever read.
  if (kind !== 'phone') return;
  const seed = defaultContacts({
    name: contacts.resolved.columnRules.firstname?.maxLength ?? 50,
    number: contacts.resolved.columnRules.phone?.maxLength ?? 20
  });
  if (seed.length === 0) return;
  // The number is sealed (MICA-432): read with what it is bound to, and opened.
  const present = openRows(
    'mica_contacts',
    (await Database.query<
      {
        citizenid: string;
        device_id: string | null;
        phone: string;
        default_number?: string | null;
      }[]
    >(
      'SELECT `citizenid`, `device_id`, `phone`, `default_number` FROM `mica_contacts` ' +
        'WHERE `device_id` = ?',
      [deviceId]
    )) ?? []
  );
  const have = new Set<string>();
  for (const row of Array.isArray(present) ? present : []) {
    have.add(sameNumberKey(String(row.phone)));
    if (row.default_number) have.add(sameNumberKey(String(row.default_number)));
  }
  for (const entry of seed) {
    const key = sameNumberKey(entry.number);
    if (have.has(key)) continue;
    // `null` when the phone holds the number live already: the race above, lost to the player.
    await repo.insertUnlessHeld({
      firstname: entry.name,
      phone: entry.number,
      default_number: entry.number,
      citizenid,
      device_id: deviceId
    } as Partial<Contact>);
    have.add(key);
  }
});

/**
 * Undo a `delete`, within `restoreWindowDays()` of it (MICA-75) — see
 * `Repository.restore` for the ownership scoping and why `updated_at` stands in for a
 * deletion timestamp.
 *
 * **Refused as `numberTaken` when the phone has a live contact with the number now**
 * (MICA-335): the player saved it again after deleting this one, and `device_phone_unique`
 * will not hold two (`ContactRepository.restore`). The row stays in Recently Deleted.
 */
contacts.app.registerEvent('restore', async (source, cbId, data, citizenid, _player, deviceId) => {
  const ok = await contacts.repo.restore(data.id, citizenid, restoreWindowDays(), deviceId);
  return { ok };
});

/**
 * The "Recently Deleted" list itself (MICA-75-wiring) — every contact `restore` above
 * could still bring back. See `Repository.findDeleted` for why this is a named action
 * rather than the generic `get`: `status` is never client-filterable.
 */
contacts.app.registerEvent(
  'getDeleted',
  async (source, cbId, data, citizenid, _player, deviceId) => {
    return await contacts.repo.findDeleted(citizenid, restoreWindowDays(), undefined, deviceId);
  }
);

const MAX_SHARE_NAME_LENGTH = 50;
const MAX_SHARE_PHONE_LENGTH = 20;
/**
 * `avatar`'s own bound (MICA-155) — the only one of the four card fields that had none,
 * fanned out to every nearby client per share. Read off the declared column rather than a
 * number invented here, so a shared card is never held to a stricter limit than a saved one
 * (`schema.avatar` above) and the two cannot drift apart. `?? Number.MAX_SAFE_INTEGER` only
 * matters if `avatar`'s declaration ever stops being length-checked at all — a sealed
 * `mediumtext` always is, to what fits sealed (MICA-432).
 */
const MAX_SHARE_AVATAR_LENGTH =
  contacts.resolved.columnRules.avatar?.maxLength ?? Number.MAX_SAFE_INTEGER;

/**
 * The card fields a sender chooses — arbitrary by design. `contacts.share` on the web side
 * offers any saved contact, not necessarily the sender's own identity (sharing someone
 * else's business card is the point), so these stay exactly what the payload said. They prove
 * nothing about who sent them, and nothing about the sender travels with them (MICA-343).
 *
 * Same clamps `AddContact` applies — the columns behind them are unchanged — declared once
 * as the event's input (MICA-210). `truncate` rather than `max` because an oversized name
 * is clipped and delivered, not refused; `min: 1` after `trim` is "not blank". Unknown keys
 * are stripped rather than refused because the web sends the whole `Contact` row it was
 * offered, and a `sender` or `citizenid` in it is ignored here exactly as any other column
 * is: nothing about the sender is read off the payload, and nothing is added below.
 */
const SHARED_CARD = s.object(
  {
    firstname: s.string({ trim: true, min: 1, truncate: MAX_SHARE_NAME_LENGTH }),
    lastname: s
      .string({ trim: true, truncate: MAX_SHARE_NAME_LENGTH })
      .optional()
      .nullable()
      .transform((value) => value ?? ''),
    phone: s.string({ trim: true, min: 1, truncate: MAX_SHARE_PHONE_LENGTH }),
    avatar: s
      .string({ truncate: MAX_SHARE_AVATAR_LENGTH })
      .optional()
      .nullable()
      .transform((value) => value ?? '')
  },
  { unknownKeys: 'strip' }
);

const SHARE_INPUT = s.tuple([SHARED_CARD]);

/**
 * Proximity contact sharing — finishes the stub in `client/services/Contact.ts`.
 *
 * A raw handler outside `ServiceEndpoint`, guarded the same way `Phone.ts`'s and
 * `Signal.ts`'s are (§2.9): the client's NUI callback already resolved optimistically, so
 * this event carries no callback id and nothing is waiting on a reply. The outcome —
 * delivered to N nearby phones, or nobody in range — reaches the sender through the
 * generic push-and-toast channel instead, the same one a delivered DM uses.
 *
 * **The card and nothing else (MICA-343).** MICA-155 attached a `sender` here — the
 * citizenid, the directory name and the *active* number — so a receiver could tell who had
 * really sent a card. It went to every player in range, so a card handed over from a burner
 * named the character and their main phone. The share is proximity-based: the receiver can
 * see who is standing next to them, and a sender number would still hand out the number of
 * the phone in hand every time somebody passes on a third party's card. So nothing about the
 * sender is attached. The card's fields stay whatever the sender chose: `contacts.share` on
 * the web side offers any saved contact, not necessarily the sender's own.
 */
onNet('mica:server:contacts:share', (...args: unknown[]) => {
  const guarded = guardNetEvent('contacts', 'share', SHARE_INPUT, args);
  if (!guarded) return;
  const { player } = guarded;
  const [cardFields] = guarded.input;

  void (async () => {
    const nearby = await findNearbyVisiblePlayers(player.source, player.citizenid);
    // The card as `SHARED_CARD` parsed it, and nothing more: anything else the payload sent
    // was stripped there, and nothing about the sender is added here (MICA-343).
    const share: SharedContactCard = { ...cardFields };

    if (typeof emitNet === 'function') {
      for (const target of nearby) {
        emitNet('mica:client:contacts:incoming', target.source, withoutOwnerKeys(share));
      }
    }

    const outcome = appEventChannel('contacts').push(
      player.citizenid,
      'share_result',
      { count: nearby.length },
      {
        persist: false,
        notify: {
          title: nearby.length > 0 ? 'Contact shared' : 'Nobody nearby',
          message:
            nearby.length > 0
              ? `Shared with ${nearby.length} nearby ${nearby.length === 1 ? 'phone' : 'phones'}.`
              : 'No Bluetooth-visible players are in range.'
        }
      }
    );
    if (!outcome.delivered && outcome.reason !== 'offline') {
      console.error(
        `[contacts] Share result push for ${who(player.citizenid)} was refused: ${outcome.reason}.`
      );
    }
  })();
});
