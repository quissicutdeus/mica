// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-201: the shell's consent record, and the one exception to it.
 *
 * A test file is its own entry point and says which side it stands in for — in-process,
 * standing in for the shell, the same declaration `registry.test.ts` makes.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const serviceMock = vi.hoisted(() => ({
  fetchSettings: vi.fn().mockResolvedValue([]),
  saveSetting: vi.fn(),
  removeSetting: vi.fn(),
  clearAppSettings: vi.fn()
}));
vi.mock('../../services/settings', () => serviceMock);

import {
  adoptExistingGrant,
  grantedPermissions,
  recordConsent,
  resetGrantsForTest,
  revokeConsent
} from './addOnGrants';
import { bundledAddOns, grantFor } from './registry';

beforeEach(() => {
  resetGrantsForTest();
});

describe('the shell-owned consent record', () => {
  it('has no grant for an add-on nobody answered for', () => {
    // `undefined`, not `[]`: both refuse at the host, and the difference is what lets the
    // migration tell "never asked" from "accepted nothing".
    expect(grantedPermissions('blabber')).toBeUndefined();
  });

  it('replaces rather than merges, so an update that drops a permission narrows the grant', () => {
    recordConsent('probe', ['storage', 'contacts']);
    recordConsent('probe', ['storage']);
    expect(grantedPermissions('probe')).toEqual(['storage']);
  });

  it('drops anything that is not a real permission', () => {
    recordConsent('probe', ['storage', 'not-a-permission' as never]);
    expect(grantedPermissions('probe')).toEqual(['storage']);
  });

  it('forgets the grant on uninstall, so a reinstall cannot inherit the old answer', () => {
    recordConsent('probe', ['contacts']);
    revokeConsent('probe');
    expect(grantedPermissions('probe')).toBeUndefined();
  });

  it('adopts only where there is no grant at all — never re-widening a narrowed one', () => {
    recordConsent('probe', []);
    adoptExistingGrant('probe', ['contacts']);
    expect(grantedPermissions('probe')).toEqual([]);
  });
});

/**
 * The bundled exception. An add-on shipped in this repository is vouched for by the build,
 * and is reachable without ever passing through the Store — a deep link (`/?app=blabber`,
 * which `a11y.spec.ts` uses) or a dev registration opens one that was never installed, with
 * no install sheet and no player to ask. A remote add-on keeps the strict rule.
 */
describe('grantFor', () => {
  const bundled = () => bundledAddOns.find((a) => (a.permissions ?? []).length > 0);

  it('answers a bundled add-on with what the build vouched for, and records it', () => {
    const app = bundled();
    expect(app, 'this build ships no bundled add-on declaring a permission').toBeDefined();
    expect(grantFor(app!.id)).toEqual(app!.permissions);
    expect(grantedPermissions(app!.id)).toEqual(app!.permissions);
  });

  it('grants nothing to an id this build does not ship — a remote add-on stays strict', () => {
    expect(grantFor('some_remote_addon')).toEqual([]);
    expect(grantedPermissions('some_remote_addon')).toBeUndefined();
  });

  it('leaves a bundled add-on’s recorded grant alone, including an empty one', () => {
    const app = bundled()!;
    recordConsent(app.id, []);
    expect(grantFor(app.id)).toEqual([]);
  });

  it('answers a remote add-on from its record and nothing else', () => {
    recordConsent('some_remote_addon', ['storage']);
    expect(grantFor('some_remote_addon')).toEqual(['storage']);
  });
});
