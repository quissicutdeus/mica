// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { isAdmin, adminAces, DEFAULT_ADMIN_ACES } from '../services/Admin';
import { FrameworkBridge, SYNTHETIC_SOURCE_MAX } from '../lib/FrameworkBridge';

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
  it('accepts the micaOS-specific ace', () => {
    granted.add('mica.admin');
    expect(isAdmin(5)).toBe(true);
  });

  it('accepts a server admin who never granted themselves mica.admin', () => {
    // The original check was `mica.admin` alone, so a full server admin was refused
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
    granted.add('mica.admin');
    expect(isAdmin(9)).toBe(false);
  });

  it('trusts the server console', () => {
    expect(isAdmin(0)).toBe(true);
  });
});

describe('a synthetic source (the integration door, MICA-397)', () => {
  /** Every ace granted to every source: only the bridge's answer may decide below the bound. */
  const grantEverything = () => {
    (globalThis as any).IsPlayerAceAllowed = () => true;
  };

  it('is no admin on a server that did not start with the door open', () => {
    // This suite's bridge is the real one, loaded with `mica_integration` unset.
    grantEverything();
    expect(FrameworkBridge.isSyntheticAdmin(-1_000_000)).toBe(false);
    expect(isAdmin(-1_000_000)).toBe(false);
    expect(isAdmin(-1_000_001)).toBe(false);
  });

  it('is answered by the bridge alone, never by an ace', () => {
    grantEverything();
    const synthetic = vi.spyOn(FrameworkBridge, 'isSyntheticAdmin');
    try {
      synthetic.mockReturnValue(false);
      expect(isAdmin(-1_000_000)).toBe(false);
      synthetic.mockReturnValue(true);
      expect(isAdmin(-1_000_000)).toBe(true);
      expect(synthetic).toHaveBeenCalledWith(-1_000_000);
    } finally {
      synthetic.mockRestore();
    }
  });

  it("routes at exactly the bridge's SYNTHETIC_SOURCE_MAX, which Admin writes out", () => {
    const synthetic = vi.spyOn(FrameworkBridge, 'isSyntheticAdmin').mockReturnValue(true);
    try {
      expect(isAdmin(SYNTHETIC_SOURCE_MAX)).toBe(true);
      expect(isAdmin(SYNTHETIC_SOURCE_MAX + 1)).toBe(false);
      expect(synthetic.mock.calls).toEqual([[SYNTHETIC_SOURCE_MAX]]);
    } finally {
      synthetic.mockRestore();
    }
  });

  it('never asks the bridge about a source above the bound, whatever it would say', () => {
    const synthetic = vi.spyOn(FrameworkBridge, 'isSyntheticAdmin').mockReturnValue(true);
    try {
      // A player with no ace, a broadcast, a line call's pseudo-source, just above the bound.
      for (const src of [5, -1, -2, -1000, -999_999]) {
        expect(isAdmin(src), String(src)).toBe(false);
      }
      expect(synthetic).not.toHaveBeenCalled();
      // The ace path still answers for a positive source that holds one.
      granted.add('mica.admin');
      expect(isAdmin(5)).toBe(true);
    } finally {
      synthetic.mockRestore();
    }
  });
});

describe('adminAces convar', () => {
  it('defaults to the built-in list', () => {
    expect(adminAces()).toEqual([...DEFAULT_ADMIN_ACES]);
  });

  it('honors an override and trims whitespace', () => {
    convar = ' mica.admin , mygroup.staff ';
    expect(adminAces()).toEqual(['mica.admin', 'mygroup.staff']);
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
