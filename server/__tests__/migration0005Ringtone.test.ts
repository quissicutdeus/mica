// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { migration } from '../migrations/0005_contact_ringtone_holds_owner_sounds';
import { MAX_OWNER_SOUND_ID } from '@mica/shared/ownerConfig';
import { contacts } from '../services/Contacts';

/**
 * MICA-256's migration, as text. `pnpm test:migrations` runs it against a real MariaDB on both
 * framework shapes, with rows in the column; this pins the guard and the statement.
 */
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
});

describe('0005_contact_ringtone_holds_owner_sounds', () => {
  it('is named for its file', () => {
    expect(migration.id).toBe('0005_contact_ringtone_holds_owner_sounds');
  });

  it('retypes the enum to a nullable varchar as wide as the longest owner sound id', async () => {
    dbMock.scalar.mockResolvedValue('enum');
    await migration.up();

    expect(dbMock.scalar.mock.calls[0][1]).toEqual(['mica_contacts', 'ringtone']);
    expect(dbMock.query).toHaveBeenCalledTimes(1);
    expect(String(dbMock.query.mock.calls[0][0])).toBe(
      'ALTER TABLE `mica_contacts` MODIFY COLUMN `ringtone` varchar(54) DEFAULT NULL'
    );
  });

  it('is frozen at the width the declaration has today', () => {
    expect(MAX_OWNER_SOUND_ID).toBe(54);
    expect(contacts.resolved.columnRules.ringtone.maxLength).toBe(54);
  });

  it.each([
    ['already a varchar', 'varchar'],
    ['a table this server never imported', null]
  ])('does nothing on %s', async (_label, type) => {
    dbMock.scalar.mockResolvedValue(type);
    await migration.up();
    expect(dbMock.query).not.toHaveBeenCalled();
  });
});
