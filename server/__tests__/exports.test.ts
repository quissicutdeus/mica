// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, bridgeMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
  bridgeMock: {
    getPlayer: vi.fn(),
    getAllPlayers: vi.fn(() => ({})),
    getCitizenId: vi.fn(),
    // The push path resolves a recipient to a live source; undefined is "offline", which
    // is the case these assertions mostly want anyway.
    getSourceByCitizenId: vi.fn(() => undefined),
    getPlayerByPhone: vi.fn(() => undefined),
    getPlayerPhone: vi.fn(),
    // The offline half of `PlayerDirectory`. It used to query `players` here directly, so
    // these cases drove it through `dbMock.single`; MICA-150 moved it behind the bridge,
    // because which table an offline player lives in is a framework question and ESX keeps
    // them in `users(identifier)`. Nobody is offline-resolvable unless a case says so.
    findOfflineByCitizenId: vi.fn(async () => null),
    findOfflineByPhone: vi.fn(async () => null),
    registerUsableItem: vi.fn()
  }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));
// The Messages service does the writing; what is under test here is the boundary in front
// of it -- argument checks, the refusals, the rate limit. `sendFromLine.test.ts` has the rest.
const sendFromLine = vi.hoisted(() =>
  vi.fn(async () => ({ conversationId: 1, messageId: 2, delivered: false }))
);
vi.mock('../services/Messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/Messages')>()),
  sendFromLine
}));

import { registerPublicApi } from '../lib/publicApi';
import {
  publishedExport,
  publishedExports,
  MICA_API_VERSION,
  __resetExportRateLimits
} from '../lib/exports';
import { lookupLine } from '../lib/numberRegistry';

const SRC = 7;
const CID = 'ABC12345';

/**
 * The public surface, pinned.
 *
 * This is `routes.test.ts`'s job one layer out. These names are called from other people's
 * resources, so a rename is a break in somebody else's script that no micaOS test would
 * otherwise notice — and the person who finds out is a server owner reading an error in
 * production.
 *
 * It can run at all because `publish` records every name whether or not `exports` is
 * callable. Under Vitest it is not: the host supplies a non-callable `exports` binding
 * that shadows the global stub, which is the same thing that forced `Mail.ts` to guard its
 * original registration.
 */
beforeEach(() => {
  vi.clearAllMocks();
  bridgeMock.getPlayer.mockReturnValue({ citizenid: CID, source: SRC, setMeta: vi.fn() });
  bridgeMock.getSourceByCitizenId.mockReturnValue(undefined);
  // A connected player has a phone by default; tests of the "no phone" gap override this.
  bridgeMock.getPlayerPhone.mockReturnValue('555-0100');
  dbMock.query.mockResolvedValue([]);
  dbMock.single.mockResolvedValue(null);
  __resetExportRateLimits();
  (globalThis as any).emitNet = vi.fn();
  registerPublicApi();
});

describe('the public export surface', () => {
  it('publishes exactly the documented names', () => {
    // Adding one here is a deliberate act. Removing or renaming one breaks a caller.
    expect(publishedExports()).toEqual([
      'AddBatteryCharge',
      'AddContact',
      'AddDeadZone',
      'AddMedia',
      'BuildDeepLink',
      'ClearGlobalSignal',
      'CreateCall',
      'GetApiVersion',
      'GetBatteryLevel',
      'GetCitizenId',
      'GetEmergencyNumber',
      'GetPhoneNumber',
      'GetSignal',
      'IsPhoneLocked',
      'IsPhoneOpen',
      'LockPhone',
      'OpenApp',
      'RegisterNumber',
      'RemoveDeadZone',
      'SendMessage',
      'SendNotification',
      'SendSystemEmail',
      'SetBatteryLevel',
      'SetCharging',
      'SetGlobalSignal',
      'SetPhoneEnabled',
      'SetSignal',
      'UnlockPhone',
      'UnregisterNumber'
    ]);
  });

  it('reports a version a caller can branch on', () => {
    const result = publishedExport('GetApiVersion')!();
    expect(result).toEqual({ ok: true, value: MICA_API_VERSION });
  });

  it('never throws across the boundary', () => {
    // An exception propagates into the *caller's* resource and takes down a script that
    // did nothing wrong. Every export is wrapped; this proves the wrapper, by handing one
    // arguments that reach code expecting otherwise.
    for (const name of publishedExports()) {
      if (name === 'SendSystemEmail') continue; // pre-existing signature, returns null
      expect(() => (publishedExport(name) as Function)(undefined, undefined), name).not.toThrow();
    }
  });

  it('answers a bad call with a reason rather than a bare false', () => {
    // A `false` that cannot distinguish "player offline" from "micaOS has not started" is
    // unusable from the calling script.
    const result = publishedExport('SendNotification')!(undefined, undefined) as any;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_args');
    expect(typeof result.message).toBe('string');
  });
});

const send = (options: unknown, citizenid: unknown = CID) =>
  publishedExport('SendNotification')!(citizenid, options) as any;

describe('SendMessage', () => {
  const text = (message: unknown, citizenid: unknown = CID) =>
    publishedExport('SendMessage')!(citizenid, message) as Promise<any>;
  const cab = { from: { name: 'Downtown Cab', number: '5550199' }, body: 'Your ride is here.' };

  it('hands a well-formed text to Messages and answers with where it landed', async () => {
    const result = await text(cab);
    expect(result).toEqual({
      ok: true,
      value: { conversationId: 1, messageId: 2, delivered: false }
    });
    expect(sendFromLine).toHaveBeenCalledWith(
      CID,
      { name: 'Downtown Cab', number: '5550199' },
      'Your ride is here.',
      undefined
    );
  });

  it('requires a citizenid, a sender and a body', async () => {
    expect((await text(cab, '')).reason).toBe('invalid_args');
    expect((await text({ body: 'hi' })).reason).toBe('invalid_args');
    expect((await text({ from: {}, body: 'hi' })).reason).toBe('invalid_args');
    expect((await text({ from: { name: 'Cab' }, body: '   ' })).reason).toBe('invalid_args');
    expect(sendFromLine).not.toHaveBeenCalled();
  });

  it('takes a name alone or a number alone, and refuses a number that is not a string', async () => {
    expect((await text({ from: { name: 'Downtown Cab' }, body: 'hi' })).ok).toBe(true);
    expect((await text({ from: { number: '5550199' }, body: 'hi' })).ok).toBe(true);
    // From Lua this mistake is easy to make and silent to read, the same as RegisterNumber.
    expect((await text({ from: { number: 5550199 }, body: 'hi' })).reason).toBe('invalid_args');
  });

  it('refuses a number a character holds rather than speak in their name', async () => {
    // `readCitizenIdByNumber` answers from `mica_phone_numbers` through `Database.single`.
    dbMock.single.mockResolvedValueOnce({ citizenid: 'SOMEBODY' });
    const result = await text(cab);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('number_in_use');
    expect(sendFromLine).not.toHaveBeenCalled();
  });

  it('refuses a recipient nobody has heard of, online or off', async () => {
    bridgeMock.getSourceByCitizenId.mockReturnValue(null);
    bridgeMock.getPlayer.mockReturnValue(null);
    const result = await text(cab, 'NOBODY');
    expect(result.reason).toBe('unknown_player');
  });

  it('is rate limited per calling resource, invalid calls included', async () => {
    for (let i = 0; i < 120; i += 1) {
      expect((await text(undefined, undefined)).reason).toBe('invalid_args');
    }
    const result = await text(cab);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rate_limited');
    expect(result.message).toContain('test-resource');
    expect(sendFromLine).not.toHaveBeenCalled();
  });
});

describe('SendNotification', () => {
  it('accepts a real micaOS app id', () => {
    expect(send({ app: 'mail', title: 'Hi', body: 'there' }).ok).toBe(true);
  });

  it('refuses an app micaOS does not have', () => {
    // Nothing validated `app` at any layer before this. An external caller makes it worth
    // closing: an invented id gets its own group in the shade and tells nobody anything.
    const result = send({ app: 'definitely_not_an_app', title: 'Hi', body: '' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ext_/);
  });

  it('requires a label for an ext_ id, and refuses one for a real app', () => {
    expect(send({ app: 'ext_towing', title: 'Hi', body: '' }).ok).toBe(false);
    expect(send({ app: 'ext_towing', sourceLabel: 'Tow Co', title: 'Hi', body: '' }).ok).toBe(true);
    // A real app already has a name in its manifest; a second one would let a caller
    // relabel Mail.
    expect(send({ app: 'mail', sourceLabel: 'Not Mail', title: 'Hi', body: '' }).ok).toBe(false);
  });

  it('refuses a deep link that does not parse', () => {
    // Refused rather than dropped: the caller believes tapping goes somewhere, and
    // silently landing on the app's home screen is a failure this codebase already paid
    // for once.
    expect(send({ app: 'mail', title: 'Hi', body: '', deepLink: 'mail/12' }).ok).toBe(false);
    expect(send({ app: 'mail', title: 'Hi', body: '', deepLink: 'mail?mailId=1' }).ok).toBe(true);
  });

  it('requires a citizenid and a title', () => {
    expect(send({ app: 'mail', title: 'Hi', body: '' }, '').ok).toBe(false);
    expect(send({ app: 'mail', title: '   ', body: '' }).ok).toBe(false);
  });

  it('treats an offline recipient as success', () => {
    // The row is written either way and they see it when they next open the phone. Only
    // the toast did not happen, and `delivered` is what says so.
    const result = send({ app: 'mail', title: 'Hi', body: 'there' });
    expect(result.ok).toBe(true);
    expect(result.value).toHaveProperty('delivered');
  });
});

describe('battery exports', () => {
  it('refuses a source with no loaded character, distinguishably', async () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);
    const result = (await publishedExport('SetBatteryLevel')!(SRC, 50)) as any;
    expect(result).toMatchObject({ ok: false, reason: 'unknown_player' });
  });

  it('refuses a source that is not a player id', async () => {
    const result = (await publishedExport('SetBatteryLevel')!('not a source', 50)) as any;
    expect(result).toMatchObject({ ok: false, reason: 'invalid_args' });
  });

  it('clamps rather than rejecting an out-of-range level', async () => {
    // The request is legitimate; only the number is not — the same call the `micacharge`
    // command already makes.
    expect(((await publishedExport('SetBatteryLevel')!(SRC, 500)) as any).value).toBe(100);
    expect(((await publishedExport('SetBatteryLevel')!(SRC, -20)) as any).value).toBe(0);
  });

  it('drains on a negative delta', async () => {
    dbMock.query.mockResolvedValue([{ id: 1, citizenid: CID, level: 40 }]);
    const result = (await publishedExport('AddBatteryCharge')!(SRC, -15)) as any;
    expect(result.value).toBe(25);
  });

  it('pushes charging to the client rather than topping the battery up', () => {
    // The drain loop is client-side; repeated top-ups from here would fight it instead of
    // joining it.
    const result = publishedExport('SetCharging')!(SRC, true) as any;
    expect(result.ok).toBe(true);
    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:battery:charging', SRC, true);
  });
});

const addMedia = (media: unknown, citizenid: unknown = CID) =>
  publishedExport('AddMedia')!(citizenid, media) as Promise<any>;

describe('AddMedia', () => {
  beforeEach(() => {
    dbMock.insert.mockResolvedValue(77);
  });

  it('accepts a hotlinked gif and returns its row id', async () => {
    // The camera can only ever produce a `photo`, so before this export the six other
    // kinds the table understands had no way to exist at all.
    const result = await addMedia({ kind: 'gif', url: 'https://x.test/a.gif' });
    expect(result).toMatchObject({ ok: true, value: { id: 77 } });
  });

  it('refuses a kind the table does not have', async () => {
    expect((await addMedia({ kind: 'hologram', url: 'https://x.test/a.gif' })).ok).toBe(false);
  });

  it('refuses a row with nothing to show', async () => {
    // Neither bytes nor a url renders as a placeholder forever, which is worse than
    // refusing the call.
    expect((await addMedia({ kind: 'photo' })).ok).toBe(false);
  });

  it('refuses a url or thumbnail that could execute', async () => {
    // `url` is `clientWritable: false`, so this export is the only way a value reaches the
    // column — which makes it the right place to refuse a scheme rather than trusting
    // every future consumer to re-check.
    expect((await addMedia({ kind: 'gif', url: 'javascript:alert(1)' })).ok).toBe(false);
    expect(
      (await addMedia({ kind: 'video', url: 'https://x.test/v.mp4', thumbnail: 'javascript:1' })).ok
    ).toBe(false);
  });

  it('writes under the citizenid it was given', async () => {
    await addMedia({ kind: 'gif', url: 'https://x.test/a.gif' }, 'OTHER99');
    const params = dbMock.insert.mock.calls[0][1] as unknown[];
    expect(params).toContain('OTHER99');
  });

  it('requires a citizenid', async () => {
    expect((await addMedia({ kind: 'gif', url: 'https://x.test/a.gif' }, '')).ok).toBe(false);
  });
});

const addContact = (contact: unknown, citizenid: unknown = CID) =>
  publishedExport('AddContact')!(citizenid, contact) as Promise<any>;

describe('AddContact', () => {
  beforeEach(() => {
    dbMock.insert.mockResolvedValue(42);
  });

  it('accepts a contact and returns its row id', async () => {
    const result = await addContact({ firstname: 'Dispatch', phone: '555-0100' });
    expect(result).toMatchObject({ ok: true, value: { id: 42 } });
  });

  it('requires a firstname and a phone', async () => {
    expect((await addContact({ phone: '555-0100' })).ok).toBe(false);
    expect((await addContact({ firstname: 'Dispatch' })).ok).toBe(false);
  });

  it('writes under the citizenid it was given', async () => {
    await addContact({ firstname: 'Dispatch', phone: '555-0100' }, 'OTHER99');
    const params = dbMock.insert.mock.calls[0][1] as unknown[];
    expect(params).toContain('OTHER99');
  });

  it('requires a citizenid', async () => {
    expect((await addContact({ firstname: 'Dispatch', phone: '555-0100' }, '')).ok).toBe(false);
  });
});

describe('phone-directory exports', () => {
  it('GetPhoneNumber resolves a citizenid to a phone', async () => {
    // null, not undefined: `PlayerDirectory.resolve` treats only `null` as "offline" and
    // falls through to the offline lookup this test is exercising.
    bridgeMock.getSourceByCitizenId.mockReturnValue(null);
    bridgeMock.findOfflineByCitizenId.mockResolvedValue({
      citizenid: CID,
      firstname: 'Ada',
      lastname: 'Lovelace',
      phone: '555-0100'
    } as any);
    const result = (await publishedExport('GetPhoneNumber')!(CID)) as any;
    expect(result).toMatchObject({ ok: true, value: '555-0100' });
  });

  it('GetPhoneNumber refuses an unknown citizenid', async () => {
    bridgeMock.getSourceByCitizenId.mockReturnValue(null);
    bridgeMock.findOfflineByCitizenId.mockResolvedValue(null);
    const result = (await publishedExport('GetPhoneNumber')!('nobody')) as any;
    expect(result).toMatchObject({ ok: false, reason: 'unknown_player' });
  });

  it('GetCitizenId resolves a phone to a citizenid', async () => {
    bridgeMock.findOfflineByPhone.mockResolvedValue({
      citizenid: CID,
      firstname: null,
      lastname: null,
      phone: '555-0100'
    } as any);
    const result = (await publishedExport('GetCitizenId')!('555-0100')) as any;
    expect(result).toMatchObject({ ok: true, value: CID });
  });

  it('GetCitizenId refuses an unknown phone', async () => {
    bridgeMock.findOfflineByPhone.mockResolvedValue(null);
    const result = (await publishedExport('GetCitizenId')!('555-9999')) as any;
    expect(result).toMatchObject({ ok: false, reason: 'unknown_player' });
  });
});

describe('GetEmergencyNumber (MICA-64)', () => {
  it('defaults to 911', () => {
    const result = publishedExport('GetEmergencyNumber')!() as any;
    expect(result).toEqual({ ok: true, value: '911' });
  });

  it('reflects an operator-configured convar', () => {
    const previous = (globalThis as any).GetConvar;
    (globalThis as any).GetConvar = (name: string, fallback: string) =>
      name === 'mica_emergency_number' ? '112' : fallback;

    const result = publishedExport('GetEmergencyNumber')!() as any;
    (globalThis as any).GetConvar = previous;

    expect(result).toEqual({ ok: true, value: '112' });
  });
});

describe('phone-state exports', () => {
  it('IsPhoneOpen defaults to closed for a source never heard from', () => {
    const result = publishedExport('IsPhoneOpen')!(SRC) as any;
    expect(result).toMatchObject({ ok: true, value: false });
  });

  it('IsPhoneOpen refuses a source that is not connected', () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);
    const result = publishedExport('IsPhoneOpen')!(SRC) as any;
    expect(result).toMatchObject({ ok: false, reason: 'unknown_player' });
  });

  it('SetPhoneEnabled pushes to the client', () => {
    const result = publishedExport('SetPhoneEnabled')!(SRC, false) as any;
    expect(result.ok).toBe(true);
    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:shell:setEnabled', SRC, false);
  });

  it('IsPhoneLocked defaults to unlocked for a source never heard from', () => {
    const result = publishedExport('IsPhoneLocked')!(SRC) as any;
    expect(result).toMatchObject({ ok: true, value: false });
  });

  it('IsPhoneLocked refuses a source that is not connected', () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);
    const result = publishedExport('IsPhoneLocked')!(SRC) as any;
    expect(result).toMatchObject({ ok: false, reason: 'unknown_player' });
  });

  it('LockPhone pushes to the client and IsPhoneLocked then answers true', () => {
    const locked = publishedExport('LockPhone')!(SRC) as any;
    expect(locked.ok).toBe(true);
    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:lockscreen:setLocked', SRC, true);

    const status = publishedExport('IsPhoneLocked')!(SRC) as any;
    expect(status).toMatchObject({ ok: true, value: true });
  });

  it('UnlockPhone pushes to the client and IsPhoneLocked then answers false', () => {
    publishedExport('LockPhone')!(SRC);
    const unlocked = publishedExport('UnlockPhone')!(SRC) as any;
    expect(unlocked.ok).toBe(true);
    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:lockscreen:setLocked', SRC, false);

    const status = publishedExport('IsPhoneLocked')!(SRC) as any;
    expect(status).toMatchObject({ ok: true, value: false });
  });

  it('LockPhone refuses a source that is not connected', () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);
    const result = publishedExport('LockPhone')!(SRC) as any;
    expect(result).toMatchObject({ ok: false, reason: 'unknown_player' });
  });

  it('OpenApp refuses an app micaOS does not have', () => {
    const result = publishedExport('OpenApp')!(SRC, 'not_an_app', {}) as any;
    expect(result).toMatchObject({ ok: false, reason: 'invalid_args' });
  });

  it('OpenApp pushes to the client for a known app', () => {
    const result = publishedExport('OpenApp')!(SRC, 'mail', { mailId: 1 }) as any;
    expect(result.ok).toBe(true);
    expect(globalThis.emitNet).toHaveBeenCalledWith('mica:client:shell:openApp', SRC, {
      appId: 'mail',
      props: { mailId: 1 }
    });
  });
});

describe('line exports (MICA-226)', () => {
  it('RegisterNumber attributes the line to the calling resource', () => {
    const register = publishedExport('RegisterNumber')!;
    const result = register('5551234', { onCall: () => ({ action: 'reject' }) });
    expect(result).toMatchObject({ ok: true });
    expect(lookupLine('5551234')?.owner).toBe('test-resource');
  });

  it('RegisterNumber carries label and job through the same two arguments (MICA-227)', () => {
    // Still two arguments: both ride in the options table, so a Lua caller written against
    // MICA-226 keeps working and one written against this gains the fields.
    const register = publishedExport('RegisterNumber')! as Function;
    const result = register('5551235', {
      onCall: () => ({ action: 'reject' }),
      label: 'LSPD Dispatch',
      job: 'police'
    });
    expect(result).toMatchObject({ ok: true });
    expect(lookupLine('5551235')).toMatchObject({ label: 'LSPD Dispatch', job: 'police' });
  });

  it('RegisterNumber refuses a malformed label or job with a reason', () => {
    const register = publishedExport('RegisterNumber')! as Function;
    const onCall = () => ({ action: 'reject' });
    expect(register('5551236', { onCall, label: 'x'.repeat(41) })).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
    expect(register('5551236', { onCall, job: 'Police Dept' })).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
    expect(lookupLine('5551236')).toBeUndefined();
  });

  it('CreateCall refuses a source nobody is connected on', async () => {
    bridgeMock.getPlayer.mockReturnValue(undefined);
    const createCall = publishedExport('CreateCall')!;
    await expect(createCall(999, '5551234')).resolves.toMatchObject({
      ok: false,
      reason: 'unknown_player'
    });
  });

  it('CreateCall refuses a connected caller with no phone number, rather than reporting ok', async () => {
    // `placeCall` returns silently for this case — no client event, nothing for the caller
    // to see go wrong. This is the gap the return-value contract exists to close: without
    // it a script would be told a call was placed when placeCall never got past its own
    // second line.
    bridgeMock.getPlayerPhone.mockReturnValue(null);
    const createCall = publishedExport('CreateCall')!;
    await expect(createCall(SRC, '5551234')).resolves.toMatchObject({
      ok: false,
      reason: 'unknown_player'
    });
  });

  it('CreateCall reports ok only once placeCall actually placed the call', async () => {
    const onCall = vi.fn(() => ({ action: 'reject' }) as const);
    (publishedExport('RegisterNumber')! as Function)('5559999', { onCall });

    const createCall = publishedExport('CreateCall')!;
    const result = await createCall(SRC, '5559999');

    // `ok` alone would also be true for a call that never happened before this fix — the
    // handler call is what proves `placeCall` actually ran the line-call path rather than
    // returning early.
    expect(result).toMatchObject({ ok: true });
    expect(onCall).toHaveBeenCalled();
  });
});
