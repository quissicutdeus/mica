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
  attachments?: { id?: number; attachment?: string; photo_id?: number }[]; // attachment is base64 for read, photo_id for creation
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

export interface Note {
  id: number;
  citizenid: string;
  title: string;
  content: string;
  status?: 'active' | 'archived' | 'deleted' | 'moderated';
  created_at: Date | string;
  updated_at: Date | string;
}

export interface Photo {
  id: number;
  citizenid: string;
  image: string; // Base64 string
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
