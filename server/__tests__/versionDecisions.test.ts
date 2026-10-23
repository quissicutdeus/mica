// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { declaredServices, type ColumnDef } from '../lib/defineService';
import { encryptedColumns } from '../lib/contentCipher';
import '../services/index';

/**
 * Every column that can hold a player's content has a decision about what an edit replaces
 * (MICA-430). The owner's rule is that everything is kept for evidence, the edits included; a
 * column is either `versioned: true` — the old value goes into the ledger with the edit — or is
 * named here with why it is not: state, a credential, a copy, or a value nothing ever rewrites.
 *
 * Fails closed. The columns asked about are every sealed one (its content was worth sealing) and
 * every text column a player's payload may write. A new one is undecided until it is versioned
 * or listed; a listed one that is now versioned, or gone, fails as a stale decision.
 */
const NEVER_REWRITTEN = 'never rewritten: written once, and only ever moved by a status change';

const EXCLUDED: Readonly<Record<string, string>> = {
  'mica_blabber_dms.body': `a DM has no edit; ${NEVER_REWRITTEN}`,
  'mica_blocklist.number': `a block is added or lifted, never edited; ${NEVER_REWRITTEN}`,
  'mica_contacts.avatar':
    'a photo of up to 4 MiB: a version a change would dwarf the ledger, and outgrow its ' +
    'snapshot beside the other fields; the gallery photo it was set from is itself kept',
  'mica_contacts.ringtone': 'a preference (an owner sound id), state rather than content',
  'mica_darkchat.code':
    "a credential, the channel's join secret: a rotation is an audit event, never the old code",
  'mica_darkchat.name': `a channel has no rename; ${NEVER_REWRITTEN}`,
  'mica_darkchat_members.alias': `set at join; a rejoin is a new row. ${NEVER_REWRITTEN}`,
  'mica_darkchat_members.handle': `set at join; a rejoin is a new row. ${NEVER_REWRITTEN}`,
  'mica_darkchat_messages.body': `a Dark Chat message has no edit; ${NEVER_REWRITTEN}`,
  'mica_darkchat_messages.bot_alias': `the server's, written with the line; ${NEVER_REWRITTEN}`,
  'mica_invoices.from_label': `written with the bill, which has no edit; ${NEVER_REWRITTEN}`,
  'mica_invoices.memo': `written with the bill, which has no edit; ${NEVER_REWRITTEN}`,
  'mica_mail.content': `server-written, and mail has no edit; ${NEVER_REWRITTEN}`,
  'mica_mail.sender': `server-written, and mail has no edit; ${NEVER_REWRITTEN}`,
  'mica_mail.sender_address': `server-written, and mail has no edit; ${NEVER_REWRITTEN}`,
  'mica_mail.subject': `server-written, and mail has no edit; ${NEVER_REWRITTEN}`,
  'mica_marketplace.description': `a listing has no edit; ${NEVER_REWRITTEN}`,
  'mica_marketplace.title': `a listing has no edit; ${NEVER_REWRITTEN}`,
  'mica_media.alt_text': `media has no edit; ${NEVER_REWRITTEN}`,
  'mica_media.data': `the photo itself, which media has no edit for; ${NEVER_REWRITTEN}`,
  'mica_media.thumbnail':
    'derived from the photo, and written only where it is still NULL: never overwritten',
  'mica_notifications.body':
    "server-written; micacrypt's blanking of a DM's copy removes a plaintext copy of a DM that " +
    'is itself kept, which a version would defeat',
  'mica_notifications.title': `server-written; ${NEVER_REWRITTEN}`,
  'mica_phone_call_log.number': `a server-written log line; ${NEVER_REWRITTEN}`,
  'mica_reports.note': `written when the report is filed; ${NEVER_REWRITTEN}`,
  'mica_reports.target_preview': `copied when the report is filed; ${NEVER_REWRITTEN}`,
  'mica_settings.app': 'a preference: settings are state (volume, theme, add-ons), not content',
  'mica_settings.setting_key':
    'a preference: settings are state (volume, theme, add-ons), not content',
  'mica_settings.setting_value':
    'a preference: settings are state, and every volume slider move is a write'
};

type Column = { table: string; column: string; def: ColumnDef };

const TEXT = new Set(['string', 'text', 'mediumtext']);

const asDef = (spec: unknown): ColumnDef =>
  typeof spec === 'string' ? ({ type: spec } as ColumnDef) : (spec as ColumnDef);

/** Every declared column, primary and child tables alike. */
const allColumns = (): Column[] => {
  const out: Column[] = [];
  for (const service of declaredServices) {
    for (const { name, def } of service.fields)
      out.push({ table: service.table, column: name, def });
    for (const child of service.childTables) {
      for (const [name, spec] of Object.entries(child.columns)) {
        out.push({ table: child.name, column: name, def: asDef(spec) });
      }
    }
  }
  return out;
};

/** The columns that need a decision: sealed, or text a player's payload may write. */
const asked = (): string[] => {
  const sealed = new Set(encryptedColumns().map((e) => `${e.table}.${e.column}`));
  const writable = new Set(
    declaredServices.flatMap((service) =>
      service.fields
        .filter((f) => service.clientWritable.includes(f.name) && TEXT.has(f.def.type))
        .map((f) => `${service.table}.${f.name}`)
    )
  );
  return [...new Set([...sealed, ...writable])].sort();
};

const versioned = (): Set<string> =>
  new Set(
    allColumns()
      .filter((c) => c.def.versioned === true)
      .map((c) => `${c.table}.${c.column}`)
  );

describe('every content column has a version decision (MICA-430)', () => {
  /**
   * MICA-430 review: a membership's `citizenid` is rewritten on every handover
   * (`transferParticipants`) and on a line's rejoin, never by its member. It always names the
   * phone's holder, and the phone's own row (`mica_devices`) keeps one version a handover, so
   * who held a membership is already on record: versioning each one would only copy that chain.
   */
  it("leaves a membership's citizenid to the phone's handover chain", () => {
    expect(versioned().has('mica_messages_participants.citizenid')).toBe(false);
  });

  it('asks about enough columns that a pass is not an empty walk', () => {
    expect(asked().length).toBeGreaterThan(30);
    expect(asked()).toContain('mica_messages.message');
    expect(asked()).toContain('mica_blabber.body');
  });

  it('versions or excludes, with a reason, every column it asks about', () => {
    const kept = versioned();
    const undecided = asked().filter((name) => !kept.has(name) && !(name in EXCLUDED));
    expect(undecided, 'version it (versioned: true) or list it in EXCLUDED with why').toEqual([]);
  });

  it('keeps no stale decision: every exclusion names a column still asked about, unversioned', () => {
    const kept = versioned();
    const open = new Set(asked());
    const stale = Object.keys(EXCLUDED).filter((name) => kept.has(name) || !open.has(name));
    expect(stale).toEqual([]);
    for (const [name, reason] of Object.entries(EXCLUDED)) {
      expect(reason.length, name).toBeGreaterThan(20);
    }
  });

  it('versions the content the owner chose to keep', () => {
    expect([...versioned()].sort()).toEqual([
      'mica_accounts.avatar',
      'mica_accounts.bio',
      'mica_accounts.display_name',
      'mica_blabber.body',
      'mica_contacts.email',
      'mica_contacts.firstname',
      'mica_contacts.lastname',
      'mica_contacts.phone',
      'mica_glimpse.caption',
      'mica_messages.message',
      'mica_messages_conversations.name',
      'mica_notes.content',
      'mica_notes.title',
      'mica_phone_numbers.device_id',
      'mica_places.name',
      'mica_places.position',
      'mica_places.street_label',
      'mica_spark.age',
      'mica_spark.bio',
      'mica_spark.looking_for'
    ]);
  });
});
