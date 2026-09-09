// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every export micaOS publishes, in one place.
 *
 * The scaffolding is `lib/exports.ts`; this is the surface itself. Split because the rules
 * about outcomes and never throwing are worth reading without the catalogue in the way,
 * and the catalogue is worth reading without the rules in the way.
 *
 * Registration happens from `server.ts` **after** `./services`, so every service has
 * finished loading before any of this can be called. Registering from inside each service
 * would put the surface back where it was — spread across the files that implement it,
 * where nothing can check it.
 */
import { FrameworkBridge } from './FrameworkBridge';
import { appEventChannel } from './appEvents';
import { buildDeepLink, parseDeepLink } from '@mica/shared/deepLink';
import { knownServices } from './services';
import * as PlayerDirectory from './PlayerDirectory';
import { isPhoneOpen } from './PhoneOpenState';
import { isPhoneLocked, setPhoneLocked } from './LockState';
import { currentEmergencyNumber, placeCall } from '../services/Phone';
import { registerNumber, unregisterNumber, type LineOptions } from './numberRegistry';
import {
  MICA_API_VERSION,
  ExportOutcome,
  fail,
  guarded,
  guardedAsync,
  rateLimited,
  ok,
  publish
} from './exports';
import { SendSystemEmail } from '../services/Mail';
import { sendFromLine, type LineSender } from '../services/Messages';
import { readCitizenIdByNumber } from './phoneNumbers';
import { phoneNumberFrom } from './netGuard';
import { getBatteryLevel, setBatteryLevel, setCharging } from '../services/Battery';
// Aliased: `AddMedia`'s own parameter is named `media` (the raw payload), which would
// otherwise shadow this import for the whole function body.
import { media as mediaService } from '../services/Media';
import { contacts } from '../services/Contacts';
import { createInvoice, type InvoiceCallbacks } from '../services/Invoices';
import {
  addDeadZone,
  describeSignalFor,
  isConnected,
  removeDeadZone,
  setGlobalSignal,
  setPlayerSignal,
  FULL_SIGNAL
} from '../services/Signal';
import type { Contact, MediaItem, MediaKind } from '@mica/shared/types';

/**
 * How an external resource names itself in the notification shade.
 *
 * `ext_<resource>` rather than a free string, and the reservation is enforced at the other
 * end: `defineApp` rejects an id starting with `ext_`, so an external id can never collide
 * with a micaOS app that ships later. Without that check the prefix is a convention, and a
 * convention is what fails the day somebody ships an app called `ext_tracker`.
 */
const EXTERNAL_PREFIX = 'ext_';

const APP_ID = /^[a-z][a-z0-9_]*$/;

/**
 * Which `app` values an external caller may group a notification under.
 *
 * Validated against `knownServices()`, which is every service the server answers to. That
 * is an approximation of "every app": an app with no server service — Calculator — cannot
 * be named here. It is the right approximation anyway, because an app with no service has
 * nothing to show when the player taps the notification.
 */
const isKnownApp = (app: string): boolean => knownServices().includes(app);

export interface ExternalNotification {
  /** A micaOS app id, or `ext_<resource>` for your own group. */
  app: string;
  /** Required for an `ext_` id, refused for a real app id. What the shade shows as the group. */
  sourceLabel?: string;
  title: string;
  body: string;
  /** An image URL, shown in place of the group's initial. */
  avatar?: string;
  /** Where tapping should land, as `app?key=value`. Built with `buildDeepLink`. */
  deepLink?: string;
  kind?: string;
}

/**
 * Raise a notification on a player's phone.
 *
 * Keyed by **citizenid**, not source, so it works while the player is offline: the row is
 * written either way and they see it when they next open the phone. The return value says
 * which happened.
 */
const SendNotification = (
  citizenid: unknown,
  options: unknown
): ExportOutcome<{ delivered: boolean }> => {
  if (typeof citizenid !== 'string' || !citizenid.trim()) {
    return fail('invalid_args', 'A citizenid is required.');
  }
  if (!options || typeof options !== 'object') {
    return fail('invalid_args', 'A notification object is required.');
  }

  const opts = options as Partial<ExternalNotification>;
  const app = String(opts.app ?? '').toLowerCase();

  if (!APP_ID.test(app)) {
    return fail('invalid_args', `'${opts.app}' is not a valid app id.`);
  }

  const isExternal = app.startsWith(EXTERNAL_PREFIX);

  // Nothing validated `app` before this existed, at any layer — the field was mandatory
  // and its value was whatever arrived. An external caller makes that worth closing.
  if (!isExternal && !isKnownApp(app)) {
    return fail(
      'invalid_args',
      `'${app}' is not a micaOS app. Use 'ext_<resource>' for your own notifications.`
    );
  }
  if (isExternal && !String(opts.sourceLabel ?? '').trim()) {
    return fail('invalid_args', `An '${EXTERNAL_PREFIX}' app id requires a sourceLabel.`);
  }
  if (!isExternal && opts.sourceLabel) {
    return fail('invalid_args', 'sourceLabel applies only to an ext_ app id.');
  }

  const title = String(opts.title ?? '').trim();
  const body = String(opts.body ?? '').trim();
  if (!title) return fail('invalid_args', 'A title is required.');

  // Refused rather than dropped. A link that does not parse means the caller believes
  // tapping goes somewhere, and silently landing on the app's home screen is the failure
  // this codebase has already paid for once.
  if (opts.deepLink && !parseDeepLink(String(opts.deepLink))) {
    return fail('invalid_args', `'${opts.deepLink}' is not a valid deep link.`);
  }

  const outcome = appEventChannel(app).push(
    citizenid,
    'external',
    { source_label: opts.sourceLabel ?? null },
    {
      notify: { type: 'info', title, message: body },
      kind: String(opts.kind ?? 'external'),
      title,
      deepLink: opts.deepLink ? String(opts.deepLink) : undefined
    }
  );

  // `offline` is a success here and not a failure: the row is written, and the player sees
  // it when they next open the phone. Only the toast did not happen.
  return ok({ delivered: outcome.delivered });
};

/** Resolve a source to a loaded character, or say which way it failed. */
const citizenOf = (source: unknown): { citizenid: string } | ExportOutcome<never> => {
  if (typeof source !== 'number' || !Number.isInteger(source) || source <= 0) {
    return fail<never>('invalid_args', 'A player source is required.');
  }
  const player = FrameworkBridge.getPlayer(source);
  if (!player?.citizenid) {
    return fail<never>('unknown_player', 'No character is loaded on that player.');
  }
  return { citizenid: player.citizenid };
};

const isFailure = <T>(value: unknown): value is ExportOutcome<T> =>
  typeof value === 'object' && value !== null && 'ok' in value;

const MEDIA_KINDS: readonly MediaKind[] = [
  'photo',
  'video',
  'audio',
  'gif',
  'sticker',
  'file',
  'link'
];

/** Only schemes that cannot execute, matching what `MediaThumb` will render. */
const SAFE_URL = /^(https?:|data:image\/)/i;

/**
 * Put media in a player's gallery.
 *
 * The camera can only ever produce a `photo`, so before this the six other kinds the
 * table understands had no way to exist. This is how a resource hands over a GIF, a video
 * poster frame, a voice clip or a link preview.
 *
 * By citizenid, so it works offline — the row is the point, and the player finds it next
 * time they open Media.
 */
const AddMedia = async (
  citizenid: unknown,
  media: unknown
): Promise<ExportOutcome<{ id: number }>> => {
  if (typeof citizenid !== 'string' || !citizenid.trim()) {
    return fail('invalid_args', 'A citizenid is required.');
  }
  if (!media || typeof media !== 'object') {
    return fail('invalid_args', 'A media object is required.');
  }

  const item = media as Partial<MediaItem>;
  const kind = String(item.kind ?? 'photo') as MediaKind;
  if (!MEDIA_KINDS.includes(kind)) {
    return fail('invalid_args', `'${item.kind}' is not a media kind.`);
  }

  // One of the two, or there is nothing to show. A row with neither renders as a labelled
  // placeholder forever, which is a worse outcome than refusing the call.
  const url = item.url ? String(item.url) : undefined;
  const data = item.data ? String(item.data) : undefined;
  if (!url && !data) {
    return fail('invalid_args', 'Either `url` or `data` is required.');
  }

  // Checked here as well as at render. `url` is `clientWritable: false`, so this export is
  // the only way a value reaches the column — which makes it the right place to refuse a
  // scheme, rather than relying on every future consumer to re-check.
  if (url && !SAFE_URL.test(url.trim())) {
    return fail('invalid_args', 'A url must be http(s) or a data:image.');
  }
  if (item.thumbnail && !SAFE_URL.test(String(item.thumbnail).trim())) {
    return fail('invalid_args', 'A thumbnail must be http(s) or a data:image.');
  }

  const repo = mediaService.repo as unknown as {
    addForPlayer(citizenid: string, item: Partial<MediaItem>): Promise<number>;
  };

  const id = await repo.addForPlayer(citizenid, {
    kind,
    data,
    url,
    thumbnail: item.thumbnail ? String(item.thumbnail) : undefined,
    mime_type: item.mime_type ? String(item.mime_type) : undefined,
    width: Number.isFinite(item.width) ? Number(item.width) : undefined,
    height: Number.isFinite(item.height) ? Number(item.height) : undefined,
    duration_ms: Number.isFinite(item.duration_ms) ? Number(item.duration_ms) : undefined,
    byte_size: Number.isFinite(item.byte_size) ? Number(item.byte_size) : undefined,
    alt_text: item.alt_text ? String(item.alt_text).slice(0, 255) : undefined
  });

  return ok({ id });
};

/**
 * Add a contact to a player's address book.
 *
 * By citizenid, so a job handing out a dispatch number can write it whether or not the
 * player is on right now — the row is the point, same reasoning as `AddMedia`.
 */
const AddContact = async (
  citizenid: unknown,
  contact: unknown
): Promise<ExportOutcome<{ id: number }>> => {
  if (typeof citizenid !== 'string' || !citizenid.trim()) {
    return fail('invalid_args', 'A citizenid is required.');
  }
  if (!contact || typeof contact !== 'object') {
    return fail('invalid_args', 'A contact object is required.');
  }

  const item = contact as Partial<Contact>;
  const firstname = String(item.firstname ?? '').trim();
  const phone = String(item.phone ?? '').trim();
  if (!firstname) return fail('invalid_args', 'A firstname is required.');
  if (!phone) return fail('invalid_args', 'A phone is required.');

  const repo = contacts.repo as unknown as {
    addForPlayer(citizenid: string, item: Partial<Contact>): Promise<number>;
  };

  const id = await repo.addForPlayer(citizenid, {
    firstname: firstname.slice(0, 50),
    lastname: item.lastname ? String(item.lastname).slice(0, 50) : undefined,
    phone: phone.slice(0, 20),
    email: item.email ? String(item.email).slice(0, 100) : undefined,
    favorite: item.favorite === true
  });

  return ok({ id });
};

/**
 * A text from something that is not a player (MICA-223): `SendMessage(citizenid, message)`.
 *
 * `from` names the sender -- `name` (a business, shown as the thread's title) and/or
 * `number` (a line, what a block is checked against and what shows when there is no name).
 * A number a character holds is refused: this export speaks for businesses and lines, and
 * putting words in a player's mouth is not a thing another resource gets to do quietly.
 * The recipient is a citizenid because this has to work offline; the row lands in the thread
 * and the toast is skipped, and `delivered` says which happened.
 */
export interface ExternalMessage {
  from: { name?: string; number?: string };
  body: string;
  attachments?: unknown;
}

/** Per calling resource. A dispatch script texting a whole department fits; a stuck loop does not. */
const SEND_MESSAGE_PER_MINUTE = 120;

/** `mica_messages.message` is `text`; the same bound the player-facing contract enforces. */
const MESSAGE_BODY_MAX = 65535;

const LABEL_MAX = 50;

const SendMessage = async (
  citizenid: unknown,
  message: unknown
): Promise<ExportOutcome<{ conversationId: number; messageId: number; delivered: boolean }>> => {
  type Result = { conversationId: number; messageId: number; delivered: boolean };
  if (typeof citizenid !== 'string' || !citizenid.trim()) {
    return fail<Result>('invalid_args', 'A citizenid is required.');
  }
  if (!message || typeof message !== 'object') {
    return fail<Result>('invalid_args', 'A message object is required.');
  }
  const opts = message as Partial<ExternalMessage>;
  const rawFrom = opts.from;
  if (!rawFrom || typeof rawFrom !== 'object') {
    return fail<Result>('invalid_args', "'from' is required: a name, a number, or both.");
  }
  const name = typeof rawFrom.name === 'string' ? rawFrom.name.trim() : '';
  if (name.length > LABEL_MAX) {
    return fail<Result>('invalid_args', `'from.name' is at most ${LABEL_MAX} characters.`);
  }
  const number = rawFrom.number === undefined ? null : phoneNumberFrom(rawFrom.number);
  if (rawFrom.number !== undefined && number === null) {
    return fail<Result>('invalid_args', "'from.number' must be a phone number string.");
  }
  if (!name && !number) {
    return fail<Result>('invalid_args', "'from' needs a name or a number.");
  }
  if (typeof opts.body !== 'string' || !opts.body.trim()) {
    return fail<Result>('invalid_args', 'A message body is required.');
  }
  if (opts.body.length > MESSAGE_BODY_MAX) {
    return fail<Result>(
      'invalid_args',
      `A message body is at most ${MESSAGE_BODY_MAX} characters.`
    );
  }

  const recipient = await PlayerDirectory.resolve(citizenid);
  if (!recipient) return fail<Result>('unknown_player', 'No character with that citizenid.');

  if (number && (await readCitizenIdByNumber(number))) {
    return fail<Result>(
      'number_in_use',
      'A character holds that number. SendMessage speaks for businesses and lines, not for players.'
    );
  }

  const from: LineSender = { name: name || null, number };
  return ok(await sendFromLine(citizenid, from, opts.body, opts.attachments));
};

/** What `SendInvoice` takes beside the citizenid. */
export interface ExternalInvoice {
  /** What the player reads as the biller. At most 64 characters. */
  from: string;
  /** Whole currency units, positive. */
  amount: number;
  /** At most 140 characters. Shown to the player and passed to the payment log. */
  memo?: string;
  /** The job whose society account is paid. Exactly one of `society` and `payee`. */
  society?: string;
  /** The character paid. Exactly one of `society` and `payee`. */
  payee?: string;
  /** Called when the player pays or declines. In memory only; see `Invoices.ts`. */
  onPaid?: (invoice: unknown) => unknown;
  onDeclined?: (invoice: unknown) => unknown;
}

const INVOICE_FROM_MAX = 64;
const INVOICE_MEMO_MAX = 140;
const INVOICE_AMOUNT_MAX = 1_000_000_000;
const SOCIETY_KEY = /^[a-z][a-z0-9_]*$/;
const SEND_INVOICE_PER_MINUTE = 60;

/**
 * Bill a player (MICA-240). Works offline: the row is written and the notification is in
 * their shade when they next open the phone. The server decides the amount and the
 * counterparty here, which is what keeps `Payments`' "no client-facing endpoint" true.
 */
const SendInvoice = async (
  citizenid: unknown,
  options: unknown
): Promise<ExportOutcome<{ id: number }>> => {
  type Result = { id: number };
  if (typeof citizenid !== 'string' || !citizenid.trim()) {
    return fail<Result>('invalid_args', 'A citizenid is required.');
  }
  if (!options || typeof options !== 'object') {
    return fail<Result>('invalid_args', 'An invoice object is required.');
  }
  const opts = options as Partial<ExternalInvoice>;

  const from = typeof opts.from === 'string' ? opts.from.trim() : '';
  if (!from) return fail<Result>('invalid_args', "'from' is required.");
  if (from.length > INVOICE_FROM_MAX) {
    return fail<Result>('invalid_args', `'from' is at most ${INVOICE_FROM_MAX} characters.`);
  }
  const amount = opts.amount;
  if (
    !Number.isInteger(amount) ||
    (amount as number) <= 0 ||
    (amount as number) > INVOICE_AMOUNT_MAX
  ) {
    return fail<Result>('invalid_args', "'amount' must be a positive whole number.");
  }
  const memo = opts.memo === undefined || opts.memo === null ? '' : String(opts.memo).trim();
  if (memo.length > INVOICE_MEMO_MAX) {
    return fail<Result>('invalid_args', `'memo' is at most ${INVOICE_MEMO_MAX} characters.`);
  }
  const society = typeof opts.society === 'string' ? opts.society.trim() : '';
  const payee = typeof opts.payee === 'string' ? opts.payee.trim() : '';
  if ((society && payee) || (!society && !payee)) {
    return fail<Result>('invalid_args', "Exactly one of 'society' and 'payee' is required.");
  }
  if (society && !SOCIETY_KEY.test(society)) {
    return fail<Result>('invalid_args', "'society' must be a lower_snake_case job name.");
  }
  if (opts.onPaid !== undefined && typeof opts.onPaid !== 'function') {
    return fail<Result>('invalid_args', "'onPaid' must be a function.");
  }
  if (opts.onDeclined !== undefined && typeof opts.onDeclined !== 'function') {
    return fail<Result>('invalid_args', "'onDeclined' must be a function.");
  }

  const recipient = await PlayerDirectory.resolve(citizenid);
  if (!recipient) return fail<Result>('unknown_player', 'No character with that citizenid.');

  const callbacks: InvoiceCallbacks = {
    onPaid: opts.onPaid as InvoiceCallbacks['onPaid'],
    onDeclined: opts.onDeclined as InvoiceCallbacks['onDeclined']
  };
  const id = await createInvoice(
    {
      citizenid,
      from_label: from,
      amount: amount as number,
      memo: memo || null,
      society: society || null,
      payee: payee || null,
      resource: GetInvokingResource()
    },
    callbacks
  );
  return ok({ id });
};

export function registerPublicApi(): void {
  publish(
    'GetApiVersion',
    guarded('GetApiVersion', () => ok(MICA_API_VERSION))
  );

  /**
   * The one export that already existed, moved here.
   *
   * Its signature is unchanged and it still returns the mail row or null, because server
   * owners are calling it today and a version bump is not worth breaking them for tidiness.
   * New exports use the outcome shape.
   */
  publish('SendSystemEmail', SendSystemEmail);

  publish(
    'SendMessage',
    guardedAsync('SendMessage', rateLimited('SendMessage', SEND_MESSAGE_PER_MINUTE, SendMessage))
  );

  publish('SendNotification', guarded('SendNotification', SendNotification));

  publish(
    'SendInvoice',
    guardedAsync('SendInvoice', rateLimited('SendInvoice', SEND_INVOICE_PER_MINUTE, SendInvoice))
  );

  publish('AddMedia', guardedAsync('AddMedia', AddMedia));

  publish('AddContact', guardedAsync('AddContact', AddContact));

  /** Build a deep link without needing to know the format. */
  publish(
    'BuildDeepLink',
    guarded('BuildDeepLink', (app: unknown, props: unknown) => {
      const id = String(app ?? '').toLowerCase();
      if (!APP_ID.test(id)) return fail<string>('invalid_args', `'${app}' is not a valid app id.`);
      return ok(buildDeepLink(id, (props ?? {}) as Record<string, string | number>));
    })
  );

  publish(
    'GetBatteryLevel',
    guardedAsync('GetBatteryLevel', async (source: unknown) => {
      const resolved = citizenOf(source);
      if (isFailure(resolved)) return resolved as ExportOutcome<number>;
      return ok(await getBatteryLevel(resolved.citizenid));
    })
  );

  publish(
    'SetBatteryLevel',
    guardedAsync('SetBatteryLevel', async (source: unknown, level: unknown) => {
      const resolved = citizenOf(source);
      if (isFailure(resolved)) return resolved as ExportOutcome<number>;
      if (typeof level !== 'number' || !Number.isFinite(level)) {
        return fail<number>('invalid_args', 'A level between 0 and 100 is required.');
      }
      return ok(await setBatteryLevel(source as number, level));
    })
  );

  /** Negative drains — an EMP, a taser, a long night. */
  publish(
    'AddBatteryCharge',
    guardedAsync('AddBatteryCharge', async (source: unknown, delta: unknown) => {
      const resolved = citizenOf(source);
      if (isFailure(resolved)) return resolved as ExportOutcome<number>;
      if (typeof delta !== 'number' || !Number.isFinite(delta)) {
        return fail<number>('invalid_args', 'A numeric delta is required.');
      }
      const current = await getBatteryLevel(resolved.citizenid);
      return ok(await setBatteryLevel(source as number, current + delta));
    })
  );

  /**
   * Charging is a **state**, not an event.
   *
   * The drain loop is client-side and moves the charge 0.25% every 15 seconds, so
   * "charging" has to live where the drain rate lives. Repeatedly poking
   * `AddBatteryCharge` from a house script would fight that loop rather than join it.
   */
  /**
   * Reception, the original ask behind this whole API.
   *
   * Global and per-zone are the same primitive with a precedence order rather than two
   * mechanisms: a city-wide blackout is `SetGlobalSignal(0)`, a jammer is a zone, and the
   * lowest applicable value wins. Two mechanisms would drift the first time they
   * disagreed.
   */
  publish(
    'SetGlobalSignal',
    guarded('SetGlobalSignal', (level: unknown) => {
      if (typeof level !== 'number' || !Number.isFinite(level)) {
        return fail<number>('invalid_args', `A level between 0 and ${FULL_SIGNAL} is required.`);
      }
      return ok(setGlobalSignal(level));
    })
  );

  publish(
    'ClearGlobalSignal',
    guarded('ClearGlobalSignal', () => ok(setGlobalSignal(FULL_SIGNAL)))
  );

  publish(
    'AddDeadZone',
    guarded('AddDeadZone', (zone: unknown) => {
      if (!zone || typeof zone !== 'object') {
        return fail<number>('invalid_args', 'A zone object is required.');
      }
      const z = zone as Record<string, unknown>;
      const nums = ['x', 'y', 'z', 'radius'].map((k) => Number(z[k]));
      if (nums.some((n) => !Number.isFinite(n))) {
        return fail<number>('invalid_args', 'x, y, z and radius must all be numbers.');
      }
      if (nums[3] <= 0) return fail<number>('invalid_args', 'radius must be greater than zero.');

      const created = addDeadZone({
        x: nums[0],
        y: nums[1],
        z: nums[2],
        radius: nums[3],
        level: Number.isFinite(Number(z.level)) ? Number(z.level) : 0
      });
      // The id, because removing it later is the only thing a caller can do with the zone.
      return ok(created.id);
    })
  );

  publish(
    'RemoveDeadZone',
    guarded('RemoveDeadZone', (id: unknown) => {
      if (!Number.isInteger(id)) return fail('invalid_args', 'A zone id is required.');
      return removeDeadZone(id as number)
        ? ok()
        : fail('invalid_args', `No dead zone with id ${id}.`);
    })
  );

  /** One player, overriding the zones. A tinfoil hat. `null` hands them back to the world. */
  publish(
    'SetSignal',
    guarded('SetSignal', (source: unknown, level: unknown) => {
      if (typeof source !== 'number' || !isConnected(source)) {
        return fail('unknown_player', 'That player is not connected.');
      }
      if (level !== null && (typeof level !== 'number' || !Number.isFinite(level))) {
        return fail('invalid_args', `A level between 0 and ${FULL_SIGNAL}, or null to clear.`);
      }
      setPlayerSignal(source, level as number | null);
      return ok();
    })
  );

  /**
   * The rules a player is subject to — **not** their current bars.
   *
   * Their actual level depends on where they are standing, and that is evaluated on their
   * own client (see `services/Signal.ts` for why). Returning a number here would be a
   * number the server cannot know, which is worse than not offering one.
   */
  publish(
    'GetSignal',
    guarded('GetSignal', (source: unknown) => {
      if (typeof source !== 'number' || !isConnected(source)) {
        return fail('unknown_player', 'That player is not connected.');
      }
      return ok(describeSignalFor(source));
    })
  );

  publish(
    'SetCharging',
    guarded('SetCharging', (source: unknown, isCharging: unknown) => {
      const resolved = citizenOf(source);
      if (isFailure(resolved)) return resolved as ExportOutcome<never>;
      setCharging(source as number, isCharging === true);
      return ok();
    })
  );

  /** The phone number for a citizenid, online or off — via the same directory Blabber uses. */
  publish(
    'GetPhoneNumber',
    guardedAsync('GetPhoneNumber', async (citizenid: unknown) => {
      if (typeof citizenid !== 'string' || !citizenid.trim()) {
        return fail<string>('invalid_args', 'A citizenid is required.');
      }
      const entry = await PlayerDirectory.resolve(citizenid);
      if (!entry) return fail<string>('unknown_player', 'No character with that citizenid.');
      if (!entry.phone) return fail<string>('not_ready', 'That character has no phone number.');
      return ok(entry.phone);
    })
  );

  /**
   * The number that always connects (MICA-64), so a dispatch resource's own setup code
   * can read it rather than duplicating (and risking drift from) micaOS's own convar
   * name. What "picks up the other end" in this pass is the framework, the same as any
   * other call: a dispatch resource registers a player or NPC session whose phone number
   * *is* this value, and `Phone.ts`'s ordinary `getPlayerByPhone` lookup finds it and
   * connects the call exactly like any other. This export is the read half of that setup,
   * not a second call-answering path — there is no synthetic "dispatch picks up" flow
   * here, and building one (a two-way bridge with no framework phone number behind it at
   * all) is a larger, more decision-heavy feature than this ticket's slice covers.
   */
  publish(
    'GetEmergencyNumber',
    guarded('GetEmergencyNumber', () => ok(currentEmergencyNumber()))
  );

  /** The reverse lookup: whose phone number is this. */
  publish(
    'GetCitizenId',
    guardedAsync('GetCitizenId', async (phone: unknown) => {
      if (typeof phone !== 'string' || !phone.trim()) {
        return fail<string>('invalid_args', 'A phone number is required.');
      }
      const entry = await PlayerDirectory.resolveByPhone(phone);
      if (!entry) return fail<string>('unknown_player', 'No character with that phone number.');
      return ok(entry.citizenid);
    })
  );

  /**
   * Whether a player's phone is open right now.
   *
   * Mirrored from the client rather than asked live — see `PhoneOpenState.ts` for why
   * there is no synchronous way to ask one. `false` for a source never heard from, which
   * is also correct: a player who has never opened the phone this session has it closed.
   */
  publish(
    'IsPhoneOpen',
    guarded('IsPhoneOpen', (source: unknown) => {
      if (typeof source !== 'number' || !isConnected(source)) {
        return fail<boolean>('unknown_player', 'That player is not connected.');
      }
      return ok(isPhoneOpen(source));
    })
  );

  /**
   * Confiscate or return a player's phone. Disabling while it is open force-closes it —
   * see `client/services/Shell.ts`'s `setEnabled` handler.
   */
  publish(
    'SetPhoneEnabled',
    guarded('SetPhoneEnabled', (source: unknown, enabled: unknown) => {
      if (typeof source !== 'number' || !isConnected(source)) {
        return fail('unknown_player', 'That player is not connected.');
      }
      emitNet('mica:client:shell:setEnabled', source, enabled === true);
      return ok();
    })
  );

  /**
   * Force the lock screen up or down (MICA-60), independent of whatever passcode the
   * player has set — the same `SetPhoneEnabled`-shaped tool for a resource that needs to
   * force a *display* state rather than ask about one. This is not the passcode lock:
   * nothing behind it is authority-bearing, so locking a phone with no client listener for
   * it yet (as of this ticket) is a no-op the caller cannot tell from a real one — the same
   * as calling `SetPhoneEnabled` before `client/services/Shell.ts` existed would have been.
   */
  publish(
    'LockPhone',
    guarded('LockPhone', (source: unknown) => {
      if (typeof source !== 'number' || !isConnected(source)) {
        return fail('unknown_player', 'That player is not connected.');
      }
      setPhoneLocked(source, true);
      emitNet('mica:client:lockscreen:setLocked', source, true);
      return ok();
    })
  );

  /** The other half of `LockPhone`. */
  publish(
    'UnlockPhone',
    guarded('UnlockPhone', (source: unknown) => {
      if (typeof source !== 'number' || !isConnected(source)) {
        return fail('unknown_player', 'That player is not connected.');
      }
      setPhoneLocked(source, false);
      emitNet('mica:client:lockscreen:setLocked', source, false);
      return ok();
    })
  );

  /**
   * Whether a caller of `LockPhone`/`UnlockPhone` last locked this player, defaulting to
   * unlocked. Eventually-consistent in the same sense `IsPhoneOpen` is, except the only
   * writer is this export pair itself — there is no client push to race against.
   */
  publish(
    'IsPhoneLocked',
    guarded('IsPhoneLocked', (source: unknown) => {
      if (typeof source !== 'number' || !isConnected(source)) {
        return fail<boolean>('unknown_player', 'That player is not connected.');
      }
      return ok(isPhoneLocked(source));
    })
  );

  /**
   * Force-open the phone on a named app, the same destination shape a notification's own
   * deep link uses. `props` becomes that app's `useDeepLink` payload.
   */
  publish(
    'OpenApp',
    guarded('OpenApp', (source: unknown, appId: unknown, props: unknown) => {
      if (typeof source !== 'number' || !isConnected(source)) {
        return fail('unknown_player', 'That player is not connected.');
      }
      const id = String(appId ?? '').toLowerCase();
      if (!APP_ID.test(id) || !isKnownApp(id)) {
        return fail('invalid_args', `'${appId}' is not a micaOS app.`);
      }
      emitNet('mica:client:shell:openApp', source, {
        appId: id,
        props: props && typeof props === 'object' ? props : {}
      });
      return ok();
    })
  );

  /**
   * Own a phone number, and answer calls placed to it (MICA-226).
   *
   * The line belongs to the calling resource and is released when that resource stops, so a
   * script that crashes does not leave a number swallowing calls. `onCall` is a function ref
   * across the resource boundary: it may return `{ action: 'accept' | 'reject' }` or
   * `{ action: 'forward', source }`, synchronously or as a promise, and has five seconds.
   *
   * `label` (at most 40 characters) names the line where a contact's name would show, and
   * `job` ('police', lower_snake_case) files it under a framework job for the Jobs app
   * (MICA-227). Both are optional and both are refused with `invalid_args` when malformed,
   * rather than trimmed or dropped. Still two arguments — both ride in the options table.
   */
  publish(
    'RegisterNumber',
    guarded('RegisterNumber', (number: unknown, options: unknown) =>
      registerNumber(number, options as LineOptions, GetInvokingResource())
    )
  );

  publish(
    'UnregisterNumber',
    guarded('UnregisterNumber', (number: unknown) =>
      unregisterNumber(number, GetInvokingResource())
    )
  );

  /**
   * Start a call for a player, as a payphone or a dispatch pick-up would.
   *
   * `placeCall` reports what happened to the call rather than a bare `void`, and every
   * refusal it names becomes a failure here (MICA-276): before that, `ok` meant "dispatched"
   * and covered a rejecting line, a number nobody holds, a busy line and a blocked caller,
   * so a dispatch resource could not tell a connected call from one that had already toasted
   * the player and failed. `ok` now means the call is ringing or connected.
   *
   * Each maps onto a reason a caller already branches on rather than a new one:
   * `'unreachable'` is `unknown_player`, the same answer `GetCitizenId` gives for a number no
   * character holds — and it is the one word for a wrong number, a blocked caller and a line
   * that rejected, on purpose (MICA-64, see `PlaceCallResult`); `'busy'` is `not_ready`, the
   * reason whose documented remedy is to retry.
   */
  publish(
    'CreateCall',
    guardedAsync('CreateCall', async (src: unknown, number: unknown) => {
      if (typeof src !== 'number' || !FrameworkBridge.getPlayer(src)) {
        return fail('unknown_player', 'That player is not connected.');
      }
      const result = await placeCall(src, number);
      switch (result) {
        case 'placed':
          return ok();
        case 'invalid_target':
          return fail('invalid_args', 'A phone number is required.');
        case 'caller_has_no_phone':
          return fail('unknown_player', 'That player has no phone number.');
        case 'unreachable':
          return fail('unknown_player', 'That number is unreachable.');
        case 'busy':
          return fail('not_ready', 'That player or that number is already on a call.');
      }
    })
  );
}
