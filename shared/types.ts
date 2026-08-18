export interface Contact {
  id: number;
  citizenid: string;
  firstname: string;
  lastname?: string;
  phone: string;
  email?: string;
  avatar?: string; // Base64 string from blob
  favorite: boolean;
  status?: 'active' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

export interface Conversation {
  id: number;
  citizenid: string;
  is_group: boolean;
  name?: string;
  status?: 'active' | 'archived' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
  participants?: Participant[];
  last_message?: Message;
  unread_count?: number;
}

export interface Participant {
  id: number;
  conversation_id: number;
  citizenid: string;
  role: 'admin' | 'member';
  status?: 'active' | 'left' | 'removed' | 'moderated';
  last_read: Date | string;
  created_at: Date | string;
  left_at?: Date | string | null;
  updated_at: Date | string;
  contact?: Contact; // hydrated
}

export interface Message {
  id: number;
  conversation_id: number;
  citizenid: string; // Sender
  status?: 'active' | 'deleted' | 'moderated';
  message: string;
  created_at: Date | string;
  updated_at: Date | string;
  reply_to_id?: number | null;
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
 * A player's saved phone charge.
 *
 * gPhone owns this rather than leaning on framework character metadata: metadata is
 * only flushed to the `players` row when the framework decides to save (logout,
 * autosave interval, shutdown), so a crash or a `restart qbx_core` loses it, and the
 * shape of the metadata API differs per core. One row per citizenid.
 */
export interface PhoneBattery {
  id: number;
  citizenid: string;
  level: number;
  status?: 'active' | 'deleted';
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
  citizenid: string;
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
 * `target_table` + `target_id` rather than a foreign key, matching `gphone_audit_logs`
 * and for the same reason: the report has to outlive the content, which is the entire
 * point once that content has been moderated away.
 */
export interface Report {
  id: number;
  /** The reporter, not the author of the reported content. */
  citizenid: string;
  target_table: string;
  target_id: number;
  category: ReportCategory;
  note?: string;
  resolution: ReportResolution;
  /** Denormalised at review time so the queue survives the content disappearing. */
  target_preview?: string;
  target_author?: string;
  status?: 'active' | 'deleted';
  created_at: Date | string;
  updated_at: Date | string;
}

export interface Highscore {
  id: number;
  citizenid: string;
  app: string;
  score: number;
  created_at: Date | string;
  updated_at: Date | string;
}

/** A leaderboard row — a `Highscore` with the citizenid's name resolved server-side. */
export interface LeaderboardEntry {
  citizenid: string;
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
 * copy of a fact `gphone_account_follows` already holds, and it drifts the first time a follow is
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
export interface BlabberDm {
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

/** One correspondent in the DM inbox, with the last thing said and what is unread. */
export interface BlabberDmThread {
  peer_account_id: number;
  handle: string | null;
  display_name: string | null;
  last: BlabberDm | null;
  unread: number;
}

export interface Note {
  id: number;
  citizenid: string;
  title: string;
  content: string;
  status?: 'active' | 'archived' | 'deleted' | 'moderated';
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

/** What `gphone_media` can hold. Over-provisioned on purpose — see `services/Photos.ts`. */
export type MediaKind =
  'photo' | 'video' | 'audio' | 'gif' | 'sticker' | 'file' | 'link' | 'location';

/**
 * A row in `gphone_media` — the table the Media app is built on.
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
  citizenid: string;
  kind: MediaKind;
  /** Base64. Was `image`, and still the only field anything writes today. */
  data?: string;
  /** A remote GIF or video that is not ours to store. */
  url?: string;
  /** Poster frame, so a feed has something to draw before the media loads. */
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
  citizenid: string;
  sender: string;
  sender_address?: string;
  subject: string;
  content: string;
  status?: 'active' | 'archived' | 'deleted' | 'moderated';
  read: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface NotificationItem {
  id: number;
  citizenid: string;
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
