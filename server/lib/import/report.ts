// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `micaimport` says it did (MICA-233), one entry per source table.
 *
 * `written` means would-write on a dry run, so the dry run and the apply that follows it can
 * be compared line by line. Every row read lands in exactly one of `written` or a `skipped`
 * reason — a row that disappears from the count without a reason is the silent drop this
 * shape exists to make impossible.
 */
export type ImportSource = 'qb-phone' | 'lb-phone' | 'npwd';

export const IMPORT_SOURCES: readonly ImportSource[] = ['qb-phone', 'lb-phone', 'npwd'];

export interface TableReport {
  table: string;
  present: boolean;
  read: number;
  written: number;
  skipped: Array<{ reason: string; count: number }>;
}

export interface ImportReport {
  source: ImportSource;
  apply: boolean;
  tables: TableReport[];
}

/** The reasons a row is skipped, named once so the tests and the console agree on them. */
export const SKIP = {
  alreadyImported: 'already imported',
  duplicateInSource: 'duplicate of a source row already counted in this run',
  unresolvedOwner: 'owner could not be resolved to a character',
  unresolvedSender: 'sender could not be resolved to a character',
  unresolvedMember: 'member number could not be resolved to a character',
  numberReassigned: 'number now belongs to another character',
  senderNotMember: 'sender is not a member of the thread',
  thinThread: 'thread has fewer than two resolvable members',
  threadNotInTable: 'its thread is not in the thread table',
  alreadyParticipant: 'already a participant of the existing thread',
  alreadyInContacts: 'already in the owner’s contacts',
  alreadyInGallery: 'already in the owner’s gallery',
  noNumber: 'no phone number',
  noText: 'no text (attachments are not imported)',
  bodyTooLong: 'longer than a Blab allows (280)',
  unsafeUrl: 'not an http(s) or data:image link',
  overQuota: 'over the owner’s media quota',
  hiddenInSource: 'deleted or hidden in the source',
  unparseable: 'history column is not JSON the importer understands (whole row, counted once)',
  noAccount: 'author has no importable account',
  noHandle: 'no free handle for that account',
  noPostsApp: 'no installed app takes imported posts',
  postsAppDisabled: 'the app that takes imported posts is turned off on this server',
  duplicateMouth: 'the same account already repeats that Blab',
  writeFailed: 'could not be written; rolled back, and a re-run retries it',
  writeTimedOut: 'write timed out; a re-run retries it',
  ledgerFailed: 'could not be recorded in the import ledger',
  /**
   * Not a skip: the row **is** written and counted in `written`. It rides in `skipped` because
   * `ImportReport` has one list of labelled counts, and the label says so.
   */
  foldedAtCap:
    'NOTE, also counted in written: folded into the owner’s oldest Blabber account (at the per-app cap)'
} as const;

/** Why every message of a thread table that cannot be used was not imported. */
export const threadTableUnusable = (table: string, present: boolean): string =>
  `its thread table ${table} is ${present ? 'unreadable' : 'missing'}`;

/** Rows between progress lines on the console. */
const PROGRESS_EVERY = 5000;

/** A running count for one source table. */
export class Tally {
  read = 0;
  written = 0;
  /** Set when a read failed; a later table that depends on this one says why. */
  unreadable = false;
  private readonly skips = new Map<string, number>();

  constructor(
    readonly table: string,
    readonly present: boolean
  ) {}

  /** Count rows read, with a console line every few thousand so a long import shows life. */
  readRow(count = 1): void {
    const before = Math.floor(this.read / PROGRESS_EVERY);
    this.read += count;
    if (Math.floor(this.read / PROGRESS_EVERY) > before) {
      console.log(`[micaimport]   ${this.table}: ${this.read} rows read so far…`);
    }
  }

  skip(reason: string, count = 1): void {
    this.skips.set(reason, (this.skips.get(reason) ?? 0) + count);
  }

  toReport(): TableReport {
    return {
      table: this.table,
      present: this.present,
      read: this.read,
      written: this.written,
      skipped: [...this.skips.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    };
  }
}

/** The console rendering, one line per table and one indented line per skip reason. */
export const formatReport = (report: ImportReport): string[] => {
  const verb = report.apply ? 'written' : 'would write';
  const lines = [
    `[micaimport] ${report.source} — ${report.apply ? 'APPLIED' : 'dry run (add --apply to write)'}`
  ];
  for (const table of report.tables) {
    if (!table.present) {
      lines.push(`[micaimport]   ${table.table}: not present, nothing read`);
      continue;
    }
    lines.push(
      `[micaimport]   ${table.table}: read ${table.read}, ${verb} ${table.written}, ` +
        `skipped ${table.skipped
          .filter((s) => s.reason !== SKIP.foldedAtCap)
          .reduce((sum, s) => sum + s.count, 0)}`
    );
    for (const skip of table.skipped) {
      lines.push(`[micaimport]     ${skip.count} × ${skip.reason}`);
    }
  }
  return lines;
};
