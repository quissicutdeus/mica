// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeviceId } from './devices';

/**
 * What a ringtone may store: one of the phone's built-in ids or an owner sound's
 * `owner:<stem>` (MICA-256). A string rather than a union because the owner's half is open;
 * `isRingtoneValue` in `shared/ownerConfig.ts` is the shape check, and the server holds
 * `mica_contacts.ringtone` to it.
 */
export type RingtoneId = string;

/**
 * What a server behind the shell can do, answered by `shell:capabilities`
 * (`server/services/Capabilities.ts`) so the UI can hide what it cannot. Never a boundary: a
 * modified client can answer its own. Moved here from that file by MICA-263 so the contract,
 * the handler and the browser mock share one shape.
 */
export interface ShellCapabilities {
  /**
   * Can money move on this server at all?
   *
   * False only in standalone, where `FrameworkBridge` has no framework to ask: `getMoney`
   * answers the `-Infinity` sentinel and both `removeMoney` and `addMoney` answer `false`.
   * Bank and Hodlr exist to move money, so on such a server they are not broken apps to be
   * error-handled — they are apps with nothing behind them, and hiding them is the honest
   * rendering. (Marketplace moves none; it is a noticeboard.)
   */
  money: boolean;
  /**
   * Does anyone here know what a player does for a living? (MICA-228)
   *
   * False only in standalone, by the same reasoning as `money`: `FrameworkPlayer.getJobs`
   * there answers `[]` and both setters refuse, so a Jobs app would be a screen with nothing
   * behind it. `unknown` answers `true` for the reason `services/Capabilities.ts` gives — a qb
   * server passes through `unknown`, and hiding the app for a session is the silent failure.
   */
  jobs: boolean;
  /**
   * Which devices this server has on (MICA-263): the phone always and first, the tablet only
   * while `mica_tablet` is. A client asking to raise a device not in this list gets nothing,
   * because the server never registers its item and the client keeps it shut.
   */
  devices: DeviceId[];
}

export interface Contact {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  /**
   * The phone this row is on (MICA-282). Set by the server; absent on a row written before
   * phones were items.
   * Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433).
   */
  device_id?: string | null;
  firstname: string;
  lastname?: string;
  phone: string;
  email?: string;
  avatar?: string; // Base64 string from blob
  /**
   * Per-contact ringtone override (MICA-142). Null means "use the system ringtone" —
   * that is the default, and a null is never backfilled to `'classic'`: a contact with
   * no override must keep following the player's system-wide choice even after the
   * system default changes.
   */
  ringtone?: RingtoneId | null;
  favorite: boolean;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * What the `mica:client:contacts:incoming` NUI message carries: the card, and nothing else.
 *
 * `firstname`/`lastname`/`phone`/`avatar` are the sender's own choice, and stay arbitrary by
 * design — `contacts.share` on the web side offers *any* saved card, not necessarily the
 * sender's own identity. MICA-155 attached a `sender` (citizenid, name, active number) so a
 * receiver could tell who had sent it; MICA-343 took it off again, because it went to every
 * player in range and named the character behind a burner. The share is proximity-based, so
 * the receiver can see who is next to them; the card itself proves nothing about who that is,
 * and nothing that consumes it may treat it as if it did.
 */
export interface SharedContactCard {
  firstname: string;
  lastname: string;
  phone: string;
  avatar: string;
}

/**
 * A Messages thread as the phone receives it — the wire shape, not the row (MICA-339).
 *
 * **Nothing here names another player.** The row behind it carries the creator's `citizenid`
 * and the two phone ids of a 1:1 (`participant_a`/`participant_b`); none of them crosses to a
 * client, because a creator's citizenid and a phone id are exactly what links a burner thread to
 * the character and their main phone. The server's own row type is `ConversationRow` in
 * `server/repositories/ConversationRepository.ts`; `conversationForReader` there is the one
 * place a row becomes this.
 */
export interface Conversation {
  id: number;
  is_group: boolean;
  /** A name a member chose (a group's), or a line's label. Never a directory name for a number. */
  name?: string;
  status?: 'active' | 'archived' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
  participants?: Participant[];
  /** The newest live message, as much of it as the inbox row draws. */
  last_message?: Pick<Message, 'message' | 'created_at' | 'mine' | 'sender_id' | 'external_sender'>;
  unread_count?: number;
  /** How many live members the thread has, the caller included. */
  participant_count?: number;
  /** When the caller archived it for themselves; null while it is in the inbox. */
  archived_at?: Date | string | null;
  /**
   * The number on the other side of a 1:1 nobody else is in (MICA-350): the phone that left
   * it, or was taken out of it by a privacy delete, or a number nobody held when the thread was
   * started. No live member is there to carry it, so without this the reader sees no number at
   * all. Absent on a group, a line thread, and a 1:1 both sides are still in.
   */
  absent_number?: string | null;
}

/**
 * One member of a thread, as another member is shown them (MICA-339).
 *
 * Who a member is reaches the phone only as the number of **the phone that is in the thread**,
 * never the character holding it: no citizenid, no phone id, and no directory name. A member
 * is named on the phone from the reader's own contacts for that number, else shown as the
 * number — exactly what a real phone with no directory can do. The server's row type is
 * `ParticipantRow` in `server/repositories/ConversationRepository.ts`.
 */
export interface Participant {
  /** The membership row's own id. The key a message's `sender_id` names, within one thread. */
  id: number;
  conversation_id: number;
  role: 'admin' | 'member';
  status?: 'active' | 'left' | 'removed' | 'moderated';
  last_read: Date | string;
  created_at: Date | string;
  left_at?: Date | string | null;
  updated_at: Date | string;
  /** Whether this is the reader's own membership, worked out on the server. */
  self: boolean;
  /** The number on the phone this membership is on, or null when micaOS knows none for it. */
  phone: string | null;
}

/**
 * One message as a member of its thread receives it (MICA-339).
 *
 * The row's `citizenid` (the sender) stays on the server: matching it across threads is what
 * linked one person's burner and main phone. In its place, two answers the server works out for
 * the reader: whether they wrote it, and which member of this thread did. The server's row type
 * is `MessageRow` in `server/repositories/MessageRepository.ts`.
 */
export interface Message {
  id: number;
  conversation_id: number;
  /** Whether the reader sent this. False for a text from a line, which arrives on their row. */
  mine: boolean;
  /**
   * The `Participant.id` of the member who sent it, in this thread; null for a text from a line
   * and for a sender who has since left the thread.
   */
  sender_id: number | null;
  status?: 'active' | 'deleted' | 'moderated';
  message: string;
  created_at: Date | string;
  updated_at: Date | string;
  /**
   * Whether the sender has rewritten this since sending it.
   *
   * Derived, never stored — `MessageRepository.findByConversation` computes
   * `updated_at > created_at` in SQL, off the `ON UPDATE CURRENT_TIMESTAMP` the column
   * already carries. Optional because a freshly-sent row has never been edited and the
   * send path has no reason to say so.
   */
  edited?: boolean;
  reply_to_id?: number | null;
  /**
   * Who sent this, when it was not a player (MICA-223): the label a resource gave
   * `SendMessage` -- a business name, or the number it registered. Null, and absent from the
   * wire, for a message a player wrote.
   */
  external_sender?: string | null;
  /**
   * `photo_id` on the way in, `media` on the way back.
   *
   * It used to be a bare base64 string, which made every attachment a photo by
   * construction — a voice note or a GIF had nowhere to say what it was. `media` is a
   * projection rather than the whole row for a reason that is not tidiness: a conversation
   * is **shared**, so embedding the uploader's `citizenid` would hand it to every other
   * participant. Same reasoning as `publicColumns` on a public read (§10).
   */
  attachments?: { id?: number; photo_id?: number; media?: MediaPreview }[];
}

/**
 * A bank transaction, normalized by `BankingBridge` from whatever the server's
 * banking resource stores.
 *
 * `amount` is always a positive magnitude and `direction` carries in/out. Banking
 * scripts disagree here — Renewed-Banking stores positive amounts with the
 * direction in a separate field — so inferring direction from a negative amount
 * renders every withdrawal as a credit.
 */
export interface Transaction {
  /** The banking resource's own transaction id. A string; not a row id. */
  id: string;
  /** Positive magnitude. Never signed. */
  amount: number;
  direction: 'in' | 'out';
  /** Epoch seconds. */
  time: number;
  title?: string;
  message?: string;
  issuer?: string;
  receiver?: string;
}

/**
 * Where a player's transaction history comes from, and whether it can come at all (MICA-241).
 *
 * `provider` is the banking resource `BankingBridge` detected, or `null` when none of the
 * ones it knows is running. `available` is whether that resource exposes its history through
 * an export: qb-banking and ox_banking keep their statements to themselves — the first serves
 * them to its own UI over a callback, the second reads its own table — and micaOS reads
 * exports, never another resource's tables (§10). So a detected-but-silent script is a real
 * state, and the Bank app tells the player which rather than showing an empty list that reads
 * as broken.
 */
export interface BankHistorySource {
  provider: string | null;
  available: boolean;
}

/** What `bank:getTransactions` answers: the source, and the rows when it has any. */
export interface BankHistory extends BankHistorySource {
  transactions: Transaction[];
}

/**
 * A bill a resource presented to a player through the phone (MICA-240), as the billed player
 * receives it.
 *
 * Created only by the server, through the `SendInvoice` export — no generic action on the
 * `invoices` service is registered, so nothing a client sends can mint, edit or delete one.
 * `status` is `active` while it can still be paid or declined; `paid`, `declined` and
 * `expired` are terminal, and `expires_at` is when an open one stops being payable, set from
 * `mica_invoice_expiry_days` at creation. Exactly one of `society` and the row's `payee` names
 * where the money goes: a job's society account through the banking bridge, or a character's
 * bank.
 *
 * Not the row (MICA-433): the row also names the character paid (`payee`), which is another
 * player's citizenid and never leaves the server, and the owner's own `citizenid`, which no
 * reply carries. The server's row type is `InvoiceRow` in
 * `server/repositories/InvoiceRepository.ts`.
 */
export interface Invoice {
  id: number;
  /** Who is billed. Server-side only: no reply carries it (MICA-433). */
  citizenid?: string;
  /** What the player reads as the biller: a business or a job name. */
  from_label: string;
  /** Whole currency units. */
  amount: number;
  memo: string | null;
  /** The job whose society account is paid, or null when a character is. */
  society: string | null;
  /** The resource that sent it, so a payment can be reported back to it. */
  resource: string;
  /** Epoch seconds. */
  expires_at: number;
  /** Epoch seconds, once paid; null otherwise. */
  paid_at: number | null;
  status: 'active' | 'paid' | 'declined' | 'expired' | 'deleted';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * What paying or declining answers. On `ok` the list is the player's open invoices re-read
 * after the change, so the store replaces itself rather than removing a row it hopes is gone.
 * The money reasons are `Payments`' own, passed through so the app can say which.
 */
export type InvoiceActionOutcome =
  | { ok: true; invoices: Invoice[] }
  | {
      ok: false;
      reason:
        | 'unknown_invoice'
        | 'not_open'
        | 'expired'
        | 'invalid_amount'
        | 'same_player'
        | 'payer_offline'
        | 'recipient_offline'
        | 'insufficient_funds'
        | 'society_unavailable'
        | 'debit_failed'
        | 'credit_failed'
        | 'stranded';
    };

/**
 * A phone number a script registered under a job (MICA-227's `RegisterNumber({ job, label })`),
 * as the Jobs app lists it: a name and something to dial, nothing a player can edit.
 */
export interface JobLine {
  number: string;
  /** The script's `label`, or the number itself when it gave none. */
  label: string;
  /**
   * Whether this player may open the line's shared inbox right now (MICA-307): a line
   * `mica_job_lines` declares, and the player is its staff. Presentation only; every inbox
   * action re-checks it on the server.
   */
  inbox: boolean;
}

/** One player's thread with a job line, as its staff see it in the inbox (MICA-307). */
export interface JobLineThread {
  conversation_id: number;
  /** The player's phone number, or null when the framework has none for them. */
  from: string | null;
  /** The newest message's text, opened if sealed; empty for an attachment alone. */
  last_message: string;
  last_at: string;
  /** True when the newest message is the player's, so nobody has answered it yet. */
  awaiting_reply: boolean;
}

/** One message in a job line's thread, from the staff side (MICA-307). */
export interface JobLineMessage {
  id: number;
  conversation_id: number;
  /** `caller` for the player's own text, `line` for a reply sent as the line. */
  side: 'caller' | 'line';
  message: string;
  /** The player attached a photo. Staff see that one was sent, not the photo itself. */
  has_attachments: boolean;
  created_at: string;
}

/**
 * One job a player holds, as the phone reads it (MICA-228).
 *
 * The framework is the authority for every field: the server re-reads the whole list from
 * the bridge after any switch or duty change and answers with that, so nothing here is ever
 * a client's belief about its own job. `onDuty` is `null` for a framework or a job with no
 * duty notion at all, which is a different statement from "off duty" and renders as no
 * toggle rather than an off one. `societyBalance` is filled only for a boss grade, and is
 * `null` rather than zero when no banking resource can answer for the account.
 */
export interface JobView {
  /** The framework's key: `police`. */
  name: string;
  /** What a player reads: `LSPD`. */
  label: string;
  grade: number;
  gradeLabel: string;
  salary: number;
  onDuty: boolean | null;
  isBoss: boolean;
  /** Exactly one job is active when the list is non-empty. */
  active: boolean;
  lines: JobLine[];
  societyBalance: number | null;
}

/**
 * What a switch or a duty change answers. On `ok` the list is the framework's own state
 * re-read after the change, so the store can replace itself with it rather than guess.
 */
export type JobActionOutcome =
  | { ok: true; jobs: JobView[] }
  | { ok: false; reason: 'unknown_job' | 'not_active' | 'refused' | 'unsupported' };

/**
 * A player's saved phone charge.
 *
 * micaOS owns this rather than leaning on framework character metadata: metadata is
 * only flushed to the `players` row when the framework decides to save (logout,
 * autosave interval, shutdown), so a crash or a `restart qbx_core` loses it, and the
 * shape of the metadata API differs per core. One row per citizenid.
 */
export interface PhoneBattery {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  /**
   * The phone this charge belongs to (MICA-283).
   * Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433).
   */
  device_id?: string | null;
  level: number;
  status?: 'active' | 'deleted';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * One call, from one participant's point of view. A call between two players writes
 * two rows — one per side — so each player's log is theirs alone, with no membership
 * check needed (matches every other owner-scoped table in this codebase).
 *
 * `number` is the *other* party's phone number. No display name is stored: the client
 * resolves one from its own contacts, the same way the Favorites bar already does, so
 * an edited contact is never stale in an old log entry.
 */
export interface PhoneCallLogEntry {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  /**
   * The phone this row is on (MICA-282). Set by the server; absent on a row written before
   * phones were items.
   * Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433).
   */
  device_id?: string | null;
  kind: 'incoming' | 'outgoing' | 'missed';
  number: string;
  /** Seconds. 0 when the call was never answered. */
  duration: number;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * One stored preference, owned by a citizenid rather than by a browser profile.
 *
 * `useStorage` is `localStorage`, which is per-PC and shared between characters — so a
 * player's theme did not follow them to another machine, and a second character on the
 * same PC inherited the first one's phone. This is the same key-value shape the SDK hook
 * already exposes (`useStorage(app).setItem(key, value)`), which is what lets every
 * existing call site keep working unchanged.
 *
 * `setting_key` / `setting_value` rather than `key` / `value`: `KEY` is reserved in MySQL.
 * The generated DDL backticks every identifier so the plain names would build, but any
 * hand-written query later would be a syntax error at runtime.
 */
export interface PhoneSetting {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  /**
   * The phone this row is on (MICA-282). Set by the server; absent on a row written before
   * phones were items.
   * Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433).
   */
  device_id?: string | null;
  /** Storage namespace — `settings`, `blabber`, or an add-on's id. */
  app: string;
  setting_key: string;
  /** JSON, exactly as `useStorage` already encodes it. */
  setting_value: string;
  status?: 'active' | 'deleted';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Why a player flagged something. Fixed set rather than free text: an admin queue
 * filtered by category is useful, a queue of prose is not.
 */
export type ReportCategory =
  'spam' | 'harassment' | 'threats' | 'sexual' | 'impersonation' | 'other';

/** Where a report has got to. Separate from `status`, which is the row's own lifecycle. */
export type ReportResolution = 'pending' | 'actioned' | 'dismissed';

/**
 * A player's report of someone else's content.
 *
 * `target_table` + `target_id` rather than a foreign key, matching `mica_audit_logs`
 * and for the same reason: the report has to outlive the content, which is the entire
 * point once that content has been moderated away.
 */
export interface Report {
  id: number;
  /**
   * The reporter, not the author of the reported content.
   * Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433).
   */
  citizenid?: string;
  target_table: string;
  target_id: number;
  category: ReportCategory;
  note?: string;
  resolution: ReportResolution;
  /** Denormalised at review time so the queue survives the content disappearing. */
  target_preview?: string;
  target_author?: string;
  /**
   * The name the reporter goes by where the content was, written by the server when the
   * reported service knows one (MICA-254: the reporter's alias in a Dark Chat channel). Never
   * from the payload, and null for a service that has no such name.
   */
  reporter_label?: string | null;
  status?: 'active' | 'deleted';
  created_at: Date | string;
  updated_at: Date | string;
}

export interface Highscore {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  app: string;
  score: number;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * A leaderboard row — a `Highscore` with the citizenid's name resolved server-side. No
 * citizenid (MICA-343): the board shows the character's name, and the server keeps the key it
 * looked that name up by. The list arrives ranked, so its index is the rank.
 */
export interface LeaderboardEntry {
  score: number;
  displayName: string | null;
}

/**
 * One social identity a player posts under.
 *
 * A player may hold several per app and switch between them, which is why this is an
 * *account* rather than a profile: a profile is the presentation, an account is the thing you
 * log into. `citizenid` is the owner and never crosses to a public reader — with alts, it
 * correlates two deliberately-separate identities back to one person.
 *
 * Shared across social apps with `app` as a column rather than a table per app, because the
 * fields do not differ: Blabber, Instagram and a TikTok-alike all want exactly a handle, a
 * display name, an avatar and a bio. What differs is the *content* model, which stays per app.
 */
export interface Account {
  id: number;
  /** Absent from any public read. */
  citizenid?: string;
  /** Which app this identity belongs to — `blabber`. */
  app: string;
  /** Unique within an app. lower_snake_case, 3-32 characters, no leading @. */
  handle: string;
  display_name?: string | null;
  avatar?: string | null;
  bio?: string | null;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * One short public post.
 *
 * `citizenid` is the ownership anchor and never crosses to a public reader; `account_id` is the
 * display identity, because a player may hold several accounts and switch between them.
 * Correlating two of them back to one person is exactly what an alt exists to prevent.
 *
 * A reply is a Blab with `reply_to` set, rather than a separate table — duplicating the shape
 * would mean duplicating the edit window, the moderation predicate and the paging.
 */
export interface Blab {
  id: number;
  /** Absent from any public read. */
  citizenid?: string;
  account_id: number;
  /** Null for a plain mouth, which has nothing of its own to say. */
  body?: string | null;
  reply_to?: number | null;
  /** The Blab this one repeats. With a body it is a quote; without one, a plain repeat. */
  mouth_of?: number | null;
  /** The top-level ancestor of this Blab's reply chain, or null if this Blab *is* top-level. */
  root_id?: number | null;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
  /** Hydrated for display; not a column. */
  handle?: string;
  display_name?: string | null;
  avatar?: string | null;
  /** The Blab being mouthed, hydrated for display. */
  mouthed?: Blab | null;
  /**
   * `photo_id` on the way in, `media` on the way back — same split as `Message.attachments`
   * and for the same reason: this is a public read, so the uploader's `citizenid` must not
   * ride along on the projection (§10).
   */
  attachments?: { id?: number; photo_id?: number; media?: MediaPreview }[];
}

/**
 * A row in `mica_marketplace`. Semi-anonymous by construction: `citizenid` is the
 * owner for write authority, and is never part of a public projection — see
 * `publicColumns` in `server/lib/defineService.ts`. There is no display-identity
 * column at all, unlike `Blab`'s `account_id`: a listing has no persona to switch
 * between, it just has no name attached, full stop.
 */
export interface Listing {
  id: number;
  /**
   * The seller. Server-side only: a public read withholds it and no reply carries it
   * (MICA-433), so a listing on the wire has none.
   */
  citizenid?: string;
  title: string;
  price: number;
  description: string;
  status: 'active' | 'sold' | 'removed' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
  /** Hydrated in, never written through the generic path — see `MarketplaceRepository`. */
  attachments?: { id: number; media: MediaPreview }[];
}

/** Counts for one Blab, plus what the asking player has already done to it. */
export interface BlabEngagement {
  replies: number;
  mouths: number;
  ears: number;
  earedByMe: boolean;
  mouthedByMe: boolean;
}

/**
 * One account's standing in the follow graph.
 *
 * Counted on read rather than stored on the account row: a `follower_count` column is a second
 * copy of a fact `mica_account_follows` already holds, and it drifts the first time a follow is
 * removed by a path that forgets to decrement.
 *
 * `followedByMe` is about **one** of the viewer's accounts, not all of them — a main and an alt
 * follow different people, and the Follow button acts as whichever is active.
 */
export interface FollowStats {
  followers: number;
  following: number;
  followedByMe: boolean;
  /** Whether the viewer's account has blocked this one. Absent viewer answers `false`. */
  blockedByMe: boolean;
}

/**
 * Reaction counts for one target, plus which emoji the caller's own accounts have used.
 *
 * `counts` is keyed by emoji rather than a fixed shape — the palette is a UI affordance, not a
 * data constraint, so any table opting into reactions can carry any emoji, not a closed set.
 */
export interface ReactionSummary {
  counts: Record<string, number>;
  mine: string[];
}

/**
 * One direct message in Blabber. Strictly between two accounts.
 *
 * 1:1 by construction — two account columns and no participants table, so there is no shape a
 * third person could be added to. Identity is the *account*, not the citizenid, so two alts can
 * talk without either learning who is behind the other.
 */
/**
 * One direct message between two accounts on the identity layer, in whichever social app the
 * two accounts belong to. The row lives in `mica_blabber_dms`, which kept its name when the
 * service became `dms` (sealed bodies are bound to the table name).
 */
export interface DirectMessage {
  id: number;
  /** The sender's owner. Never crosses to the other party. */
  citizenid?: string;
  from_account: number;
  to_account: number;
  body: string;
  /** Null until the recipient opens the thread. */
  read_at?: Date | string | null;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

/** One correspondent in a DM inbox, with the last thing said and what is unread. */
export interface DirectMessageThread {
  peer_account_id: number;
  handle: string | null;
  display_name: string | null;
  last: DirectMessage | null;
  unread: number;
}

/** Blabber's names for the same two shapes, kept so nothing that reads them has to move. */
export type BlabberDm = DirectMessage;
export type BlabberDmThread = DirectMessageThread;

/**
 * One photo post in Glimpse (MICA-253), as a reader receives it.
 *
 * The public projection only, hydrated for display. `citizenid` is deliberately **not** a
 * field here rather than an optional one: it is the ownership anchor, and `account_id` is
 * the display identity, so a projection that could carry it would correlate a player's alts
 * back to one person. Likes are reactions (`mica_account_reactions`, ❤️ only) and come from
 * `reactionsFor`, not from this row.
 */
export interface GlimpsePost {
  id: number;
  account_id: number;
  /** `mica_glimpse.caption`, a varchar(500). Null for a post that is only its photos. */
  caption: string | null;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
  /** Hydrated from the author's account; not columns. */
  handle?: string;
  display_name?: string | null;
  avatar?: string | null;
  /**
   * The carousel, in posting order. `MediaPreview`, never `MediaItem`: the uploader's
   * `citizenid` must not ride along on a public read. A photo retention removed is simply
   * absent, so a post can arrive with none left.
   */
  attachments: { id: number; media: MediaPreview }[];
}

/** What `glimpse:create` answers: the post, plus the caption edit window in seconds. */
export type GlimpseCreated = GlimpsePost & { editWindow: number };

/** Counts for one post. Likes are not here: they are reactions, read through `reactionsFor`. */
export interface GlimpseEngagement {
  comments: number;
}

/** One comment under a post, as a reader receives it. No `citizenid`, for the same reason. */
export interface GlimpseComment {
  id: number;
  post_id: number;
  account_id: number;
  /** `mica_glimpse_comments.body`, a varchar(300). */
  body: string;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
  handle?: string;
  display_name?: string | null;
  avatar?: string | null;
}

/**
 * One Dark Chat channel the caller is a live member of (MICA-254), as `list` answers it.
 *
 * The join code is not here: only the owner may read it, through its own action. Nothing in
 * any Dark Chat projection names a citizenid, a phone number or an account handle, and nothing
 * names the caller's other channels, so two aliases cannot be tied to one player.
 */
export interface DarkchatChannel {
  id: number;
  /** `mica_darkchat.name`, a varchar(32). */
  name: string;
  /** The caller's own member handle in this channel, and the alias it speaks under. */
  my_member_id: string;
  my_alias: string;
  is_owner: boolean;
}

/**
 * A live member of a channel, as another member sees it. Deliberately no owner flag and no
 * join time: the same join second across two channels would link two aliases.
 */
export interface DarkchatMember {
  /**
   * An opaque random handle, never the row's integer id: that id is a global sequence, so it
   * would rank members by join order, mark the owner as the lowest, and tie one player's
   * aliases together across channels they joined one after the other.
   */
  id: string;
  /** `mica_darkchat_members.alias`, a varchar(24), unique among a channel's live members. */
  alias: string;
}

/** What `create` and `join` answer. `code` is present only for the channel's owner. */
export interface DarkchatJoined {
  channel: DarkchatChannel;
  code?: string;
}

/**
 * One message in a channel, as a member reads it (MICA-254). `member_id` is null and `bot`
 * true for a line a server script posted through the `PostToDarkChat` export; `alias` is then
 * the alias that script supplied. `mine` is computed for the reader, never stored.
 */
export interface DarkchatMessage {
  id: number;
  channel_id: number;
  /** The author's opaque member handle (see `DarkchatMember.id`), or null for a script's line. */
  member_id: string | null;
  alias: string;
  bot: boolean;
  mine: boolean;
  /** `mica_darkchat_messages.body`, at most 500 characters. */
  body: string;
  created_at: Date | string;
}

/**
 * One photo on a Spark profile (MICA-255). `id` is the Spark photo row, never the gallery's
 * `mica_media.id`: that id is global, so the same gallery photo on a Glimpse account and a
 * Spark profile would share it and tie the two together, and it also gives capture order.
 */
export interface SparkPhoto {
  id: number;
  media: Omit<MediaPreview, 'id'>;
}

/**
 * A profile as the deck shows it to another player. The account is the one Spark account the
 * player holds (one per citizen, unlisted); `display_name` is that account's. No citizenid,
 * no handle from another app, no join or swipe information of any kind.
 */
export interface SparkCard {
  id: number;
  account_id: number;
  display_name: string | null;
  /** In-character, entered by the player, at least 18. */
  age: number;
  /** `mica_spark.bio`, at most 300 characters. */
  bio: string | null;
  /** `mica_spark.looking_for`, at most 60 characters. */
  looking_for: string | null;
  /** In the order the owner arranged them; one to four. */
  photos: SparkPhoto[];
}

/** The owner's own profile: the card plus what only the owner edits. */
export interface SparkProfile extends SparkCard {
  status: 'active' | 'deleted' | 'moderated';
  /** The gallery ids behind `photos`, for the editor. Never on another player's card. */
  photo_ids: number[];
}

export type SparkVerdict = 'like' | 'pass';

/**
 * A mutual like. The thread between the two accounts is read through `useDirectMessages`
 * (`dms`, app 'spark'), keyed by `profile.account_id`; nothing about it is duplicated here.
 */
export interface SparkMatch {
  id: number;
  profile: SparkCard;
  created_at: Date | string;
}

export interface Note {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  /**
   * The phone this row is on (MICA-282). Set by the server; absent on a row written before
   * phones were items.
   * Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433).
   */
  device_id?: string | null;
  title: string;
  content: string;
  status?: 'active' | 'archived' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * A place the player named and kept, from the Places app (MICA-65).
 *
 * `x`/`y`/`z` are a snapshot at the moment the place was saved, resolved the same way a
 * shared location is — server-side, from the sender's own live position
 * (`server/services/Media.ts`'s `shareLocation`, `server/lib/playerCoords.ts`) — never
 * accepted as client-reported coordinates. `street_label` is cosmetic display text only,
 * the same trust level `shareLocation`'s own `label` carries.
 */
export interface SavedPlace {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  /**
   * The phone this row is on (MICA-282). Set by the server; absent on a row written before
   * phones were items.
   * Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433).
   */
  device_id?: string | null;
  name: string;
  street_label?: string;
  x: number;
  y: number;
  z: number;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Enough of a media row to draw it, and nothing that identifies its owner.
 *
 * What crosses the wire wherever media appears somewhere its uploader does not own the
 * whole surface — a message attachment being the first. `MediaItem` is assignable to it,
 * so a gallery row can be passed anywhere this is accepted.
 */
export type MediaPreview = Pick<
  MediaItem,
  'id' | 'kind' | 'data' | 'url' | 'thumbnail' | 'mime_type' | 'duration_ms' | 'alt_text'
>;

/** What `mica_media` can hold. Over-provisioned on purpose — see `services/Photos.ts`. */
export type MediaKind =
  'photo' | 'video' | 'audio' | 'gif' | 'sticker' | 'file' | 'link' | 'location';

/**
 * A row in `mica_media` — the table the Media app is built on.
 *
 * Named for what it holds, and now the service and app id agree: both are `media`, the
 * same rename the table made first (§11.1 — an id is a key, so it was the bigger of the
 * two changes and came second).
 *
 * Everything past `kind` is optional. Locally captured media has `data` and nothing else;
 * a hotlinked GIF has `url` and no bytes at all.
 */
export interface MediaItem {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  /**
   * The phone this row is on (MICA-282). Set by the server; absent on a row written before
   * phones were items.
   * Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433).
   */
  device_id?: string | null;
  kind: MediaKind;
  /** Base64. Was `image`, and still the only field anything writes today. */
  data?: string;
  /** A remote GIF or video that is not ours to store. */
  url?: string;
  /**
   * A small copy of the media: a poster frame for video and GIF, and for a photo the
   * camera's own downscale, written at capture time so the gallery grid has something to
   * draw that is not the original (MICA-110).
   */
  thumbnail?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  byte_size?: number;
  alt_text?: string;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

export interface Mail {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  sender: string;
  sender_address?: string;
  subject: string;
  content: string;
  status?: 'active' | 'archived' | 'deleted' | 'moderated';
  read: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

/** One price snapshot, as recorded by `server/services/HodlrMarket.ts`. */
export interface PricePoint {
  price: number;
  recorded_at: Date | string;
}

/**
 * One player's Hodlr holding — one row per citizenid, enforced by a unique index.
 * `quantity` is a whole number of the single simulated coin; the game has no
 * fractional currency or fractional coin.
 */
export interface HodlrHolding {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  quantity: number;
  status?: 'active' | 'deleted';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * One roulette bet (MICA-82). `value` is the number for `straight` (0..36) and the dozen or
 * column for `dozen`/`column` (1..3); every other kind carries none. `amount` is whole bank cash.
 */
export interface CasinoBet {
  kind: 'straight' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high' | 'dozen' | 'column';
  value?: number;
  amount: number;
}

/**
 * A settled roulette spin. `stake` is the total of every bet, debited once before the spin;
 * `payout` is everything credited back after it — each winning bet's amount plus its winnings,
 * so a 35:1 straight of 10 pays 360 and a losing spin pays 0.
 */
export interface CasinoSpinResult {
  round_id: number;
  number: number;
  color: 'red' | 'black' | 'green';
  stake: number;
  payout: number;
}

/**
 * A Crash round still in play. `started_at` is the server's clock in epoch ms: the multiplier
 * is a function of the server's time since then, and the client only draws it.
 */
export interface CasinoCrashRound {
  round_id: number;
  stake: number;
  started_at: number;
}

/**
 * One of the caller's own rounds, as `history` pages them. Multipliers are ×100 integers.
 *
 * `multiplier` is the Crash cash-out, null for a bust and for roulette. `crash_point` is null on
 * a round still in play — it is the hidden outcome until the round settles — and on roulette.
 * `number` and `bets` are roulette's, null on Crash.
 */
export interface CasinoRound {
  id: number;
  game: 'roulette' | 'crash';
  status: 'active' | 'settled';
  stake: number;
  payout: number;
  multiplier: number | null;
  crash_point: number | null;
  number: number | null;
  bets: CasinoBet[] | null;
  created_at: Date | string;
}

/**
 * A place the player named and kept, from the Places app (MICA-65).
 *
 * `x`/`y`/`z` are a snapshot at the moment the place was saved, resolved the same way a
 * shared location is — server-side, from the sender's own live position
 * (`server/services/Media.ts`'s `shareLocation`, `server/lib/playerCoords.ts`) — never
 * accepted as client-reported coordinates. `street_label` is cosmetic display text only,
 * the same trust level `shareLocation`'s own `label` carries.
 */
export interface SavedPlace {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  /**
   * The phone this row is on (MICA-282). Set by the server; absent on a row written before
   * phones were items.
   * Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433).
   */
  device_id?: string | null;
  name: string;
  street_label?: string;
  x: number;
  y: number;
  z: number;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

export interface NotificationItem {
  id: number;
  /** Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433). */
  citizenid?: string;
  /**
   * The phone this row is on (MICA-282). Set by the server; absent on a row written before
   * phones were items.
   * Never on the wire: the server strips it from every reply (`withoutOwnerKeys`, MICA-433).
   */
  device_id?: string | null;
  app: string;
  kind: string;
  title: string;
  body: string;
  avatar?: string | null;
  deep_link?: string | null;
  read_at?: Date | string | null;
  cleared_at?: Date | string | null;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * One category of a player's data export (MICA-168): the rows of one owned table.
 *
 * A column whose value is media bytes appears as `<column>_bytes` (its size) instead of the
 * bytes. A column that is a credential or another player's identity is absent, and named in
 * `withheld`. `truncated` says why the rows stop short, when they do: `'rows'` for the
 * per-category row cap, `'size'` for the whole export's size budget.
 */
export interface PrivacyExportCategory {
  /**
   * The category's id: the table without its `mica_` prefix — `notes`,
   * `messages_participants`. The UI labels it from its own catalog.
   */
  category: string;
  rows: Record<string, unknown>[];
  truncated: false | 'rows' | 'size';
  withheld: string[];
}

export interface PrivacyExport {
  generatedAt: string;
  /** The size budget the rows were cut to, in JSON characters. */
  limitChars: number;
  /** True when any category was cut short. */
  truncated: boolean;
  categories: PrivacyExportCategory[];
}

/**
 * What deleting a player's data did (MICA-168). `complete` is false when any category failed
 * to delete, and `failed` names them; a partial delete is never reported as a whole one.
 * `kept` counts rows held back because an open report names them, or because deleting them
 * would take another player's rows with them by cascade (a thread with someone else's
 * messages in it, a post with someone else's reply under it); `null` when that count could not
 * be taken. Moderation, accountability and device records are kept by design and not counted.
 */
export interface PrivacyDeleteResult {
  complete: boolean;
  removed: number;
  kept: number | null;
  failed: string[];
}
