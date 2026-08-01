import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { isAdmin, adminAces, DEFAULT_ADMIN_ACES } from '../services/Admin';

/** Aces the fake server has granted to source 5. */
let granted = new Set<string>();
let convar = '';

beforeEach(() => {
  granted = new Set();
  convar = '';
  (globalThis as any).IsPlayerAceAllowed = (src: string, ace: string) =>
    src === '5' && granted.has(ace);
  (globalThis as any).GetConvar = (_name: string, fallback: string) => convar || fallback;
});

describe('admin ace resolution', () => {
  it('accepts the gPhone-specific ace', () => {
    granted.add('gphone.admin');
    expect(isAdmin(5)).toBe(true);
  });

  it('accepts a server admin who never granted themselves gphone.admin', () => {
    // The original check was `gphone.admin` alone, so a full server admin was refused
    // by their own phone until they granted a second ace. `add_ace group.admin command
    // allow` is the near-universal setup and already lets them do everything the
    // Developer Tools offer, from console.
    granted.add('command');
    expect(isAdmin(5)).toBe(true);
  });

  it('refuses a player with neither', () => {
    granted.add('some.unrelated.ace');
    expect(isAdmin(5)).toBe(false);
  });

  it('refuses a different source holding the ace', () => {
    granted.add('gphone.admin');
    expect(isAdmin(9)).toBe(false);
  });

  it('trusts the server console', () => {
    expect(isAdmin(0)).toBe(true);
  });
});

describe('adminAces convar', () => {
  it('defaults to the built-in list', () => {
    expect(adminAces()).toEqual([...DEFAULT_ADMIN_ACES]);
  });

  it('honours an override and trims whitespace', () => {
    convar = ' gphone.admin , mygroup.staff ';
    expect(adminAces()).toEqual(['gphone.admin', 'mygroup.staff']);
  });

  it('an override actually changes who is admin', () => {
    convar = 'mygroup.staff';
    granted.add('command');
    expect(isAdmin(5)).toBe(false);

    granted.add('mygroup.staff');
    expect(isAdmin(5)).toBe(true);
  });

  it('falls back rather than locking everyone out on an empty convar', () => {
    // A blank or comma-only value would otherwise resolve to no aces at all, which
    // silently denies every player including the owner who set it.
    for (const blank of ['', '   ', ',', ' , , ']) {
      convar = blank;
      expect(adminAces(), `convar ${JSON.stringify(blank)}`).toEqual([...DEFAULT_ADMIN_ACES]);
    }
  });

  it('is read per check, so a permission change needs no restart', () => {
    granted.add('mygroup.staff');
    expect(isAdmin(5)).toBe(false);

    convar = 'mygroup.staff';
    expect(isAdmin(5)).toBe(true);
  });
});
