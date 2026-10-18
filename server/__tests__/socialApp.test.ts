// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';

/**
 * `defineSocialApp` (MICA-394): one object feeding the account-policy, DM-policy and block-handler
 * registries, with one duplicate check, an undo on a partial registration, and one test seam.
 *
 * The registries are the real ones, read back through their own test seams, so "registered" here
 * means what `Accounts.ts` and `DirectMessages.ts` will actually answer with. Blabber, Glimpse and
 * Spark are loaded too, and what their module load left in each registry is pinned to what their
 * separate `register*` calls left before.
 */

vi.mock('../lib/Database', () => ({
  Database: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/DiscordWebhook', () => ({ forwardReportFiled: vi.fn(), forwardAudit: vi.fn() }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => null,
    getCitizenId: () => null,
    getSourceByCitizenId: () => null,
    getSourcesByCitizenId: () => new Map(),
    registerUsableItem: () => {}
  }
}));

import { defineSocialApp, resetSocialAppsForTests } from '../lib/socialApp';
import {
  accountAppPolicyForTests,
  accountBlockHandlerForTests,
  onAccountBlocked,
  unregisterAccountBlocked
} from '../services/Accounts';
import { dmPolicyForTests, registerDmPolicy, unregisterDmPolicy } from '../services/DirectMessages';
import { buildDeepLink } from '@mica/shared/deepLink';
import type { Account } from '@mica/shared/types';
import '../services/Blabber';
import '../services/Glimpse';
import '../services/Spark';

const dms = () => ({
  canSend: () => true,
  notify: () => ({ title: 't', message: 'm', deepLink: 'd' })
});
const onBlocked = async (): Promise<void> => {};

/** Every registry's entry for one app, as the registries themselves answer. */
const registered = (appId: string) => ({
  accounts: accountAppPolicyForTests(appId),
  dms: dmPolicyForTests(appId),
  onBlocked: accountBlockHandlerForTests(appId)
});

const ADA = { id: 7, handle: 'ada' } as Account;

describe('what each app registers at module load, unchanged by MICA-394', () => {
  it('Spark: one unlisted account per citizen, a match-gated DM policy, and a block handler', () => {
    const spark = registered('spark');
    expect(spark.accounts).toEqual({ maxPerCitizen: 1, listed: false });
    expect(Object.isFrozen(spark.accounts)).toBe(true);
    expect(Object.keys(spark.dms ?? {}).sort()).toEqual(['canRead', 'canSend', 'notify']);
    expect(spark.dms?.notify(ADA, 'hello there')).toEqual({
      title: 'Spark',
      message: 'New message',
      deepLink: buildDeepLink('spark', { accountId: 7 })
    });
    expect(typeof spark.onBlocked).toBe('function');
  });

  it.each(['blabber', 'glimpse'])('%s: a DM policy and nothing else', async (appId) => {
    const entry = registered(appId);
    expect(entry.accounts).toBeUndefined();
    expect(entry.onBlocked).toBeUndefined();
    expect(Object.keys(entry.dms ?? {}).sort()).toEqual(['canSend', 'notify']);
    expect(await entry.dms?.canSend(ADA, ADA)).toBe(true);
    const text = 'x'.repeat(200);
    expect(entry.dms?.notify(ADA, text)).toEqual({
      title: '@ada',
      message: 'x'.repeat(120),
      deepLink: buildDeepLink(appId, { dmHandle: 'ada' })
    });
  });

  it('a second definition of a loaded app is refused, and its registrations stand', () => {
    const before = registered('spark');
    expect(() => defineSocialApp('spark', { dms: dms() })).toThrow(
      "defineSocialApp: 'spark' is already defined."
    );
    expect(registered('spark')).toEqual(before);
    expect(registered('spark').dms).toBe(before.dms);
  });
});

describe('defineSocialApp', () => {
  it('registers all three from one object', () => {
    const policy = dms();
    defineSocialApp('soc_all', { accounts: { maxPerCitizen: 2 }, dms: policy, onBlocked });
    expect(registered('soc_all')).toEqual({
      accounts: { maxPerCitizen: 2 },
      dms: policy,
      onBlocked
    });
  });

  it('registers only what it names', () => {
    defineSocialApp('soc_dms_only', { dms: dms() });
    const entry = registered('soc_dms_only');
    expect(entry.dms).toBeDefined();
    expect(entry.accounts).toBeUndefined();
    expect(entry.onBlocked).toBeUndefined();
  });

  it('refuses a definition that names nothing', () => {
    expect(() => defineSocialApp('soc_empty', {})).toThrow("'soc_empty' registers nothing");
  });

  it('refuses a duplicate before touching any registry', () => {
    defineSocialApp('soc_dup', { dms: dms() });
    // Neither slot is taken yet, so a check made after registering would have filled them.
    expect(() => defineSocialApp('soc_dup', { accounts: { listed: false }, onBlocked })).toThrow(
      "'soc_dup' is already defined"
    );
    expect(accountAppPolicyForTests('soc_dup')).toBeUndefined();
    expect(accountBlockHandlerForTests('soc_dup')).toBeUndefined();
  });

  it('undoes the registrations already made when a later registry refuses, then rethrows', () => {
    const direct = dms();
    registerDmPolicy('soc_clash', direct);
    expect(() =>
      defineSocialApp('soc_clash', { accounts: { maxPerCitizen: 1 }, dms: dms(), onBlocked })
    ).toThrow("registerDmPolicy: 'soc_clash' already has a DM policy.");
    expect(registered('soc_clash')).toEqual({
      accounts: undefined,
      dms: direct,
      onBlocked: undefined
    });
    expect(registered('soc_clash').dms).toBe(direct);

    // The positive twin: the refused definition was not recorded, so once the clash is gone the
    // same definition goes through.
    unregisterDmPolicy('soc_clash');
    defineSocialApp('soc_clash', { accounts: { maxPerCitizen: 1 }, dms: dms(), onBlocked });
    expect(registered('soc_clash').accounts).toEqual({ maxPerCitizen: 1 });
    expect(registered('soc_clash').onBlocked).toBe(onBlocked);
  });

  it('undoes both earlier registrations when the last one refuses', () => {
    const direct = async (): Promise<void> => {};
    onAccountBlocked('soc_late', direct);
    expect(() =>
      defineSocialApp('soc_late', { accounts: { listed: false }, dms: dms(), onBlocked })
    ).toThrow("onAccountBlocked: 'soc_late' already has a block handler.");
    expect(registered('soc_late')).toEqual({
      accounts: undefined,
      dms: undefined,
      onBlocked: direct
    });
    unregisterAccountBlocked('soc_late');
  });

  it('leaves every registry alone when the first one refuses', () => {
    expect(() =>
      defineSocialApp('soc_badcap', { accounts: { maxPerCitizen: 0 }, dms: dms(), onBlocked })
    ).toThrow('maxPerCitizen must be a positive integer');
    expect(registered('soc_badcap')).toEqual({
      accounts: undefined,
      dms: undefined,
      onBlocked: undefined
    });
  });
});

// Last in the file: it clears the three apps' module-load registrations too.
describe('resetSocialAppsForTests', () => {
  it('clears every registry each defined app fed, and nothing registered directly', () => {
    const direct = dms();
    registerDmPolicy('soc_direct', direct);
    expect(registered('soc_all').accounts).toBeDefined();
    expect(registered('spark').onBlocked).toBeDefined();

    resetSocialAppsForTests();

    for (const appId of ['soc_all', 'soc_dms_only', 'soc_dup', 'soc_clash', 'spark', 'blabber']) {
      expect(registered(appId)).toEqual({
        accounts: undefined,
        dms: undefined,
        onBlocked: undefined
      });
    }
    expect(dmPolicyForTests('soc_direct')).toBe(direct);
    unregisterDmPolicy('soc_direct');

    // The duplicate check was cleared with them: the same app can be defined afresh.
    defineSocialApp('spark', { dms: direct });
    expect(dmPolicyForTests('spark')).toBe(direct);
    resetSocialAppsForTests();
  });
});
