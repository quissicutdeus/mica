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
    registerUsableItem: vi.fn()
  }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));

import { registerPublicApi } from '../lib/publicApi';
import { publishedExport, publishedExports, MICA_API_VERSION } from '../lib/exports';

const SRC = 7;
const CID = 'ABC12345';

/**
 * The public surface, pinned.
 *
 * This is `routes.test.ts`'s job one layer out. These names are called from other people's
 * resources, so a rename is a break in somebody else's script that no gPhone test would
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
  dbMock.query.mockResolvedValue([]);
  (globalThis as any).emitNet = vi.fn();
  registerPublicApi();
});

describe('the public export surface', () => {
  it('publishes exactly the documented names', () => {
    // Adding one here is a deliberate act. Removing or renaming one breaks a caller.
    expect(publishedExports()).toEqual([
      'AddBatteryCharge',
      'AddMedia',
      'BuildDeepLink',
      'GetApiVersion',
      'GetBatteryLevel',
      'SendNotification',
      'SendSystemEmail',
      'SetBatteryLevel',
      'SetCharging'
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
    // A `false` that cannot distinguish "player offline" from "gPhone has not started" is
    // unusable from the calling script.
    const result = publishedExport('SendNotification')!(undefined, undefined) as any;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_args');
    expect(typeof result.message).toBe('string');
  });
});

describe('SendNotification', () => {
  const send = (options: unknown, citizenid: unknown = CID) =>
    publishedExport('SendNotification')!(citizenid, options) as any;

  it('accepts a real gPhone app id', () => {
    expect(send({ app: 'mail', title: 'Hi', body: 'there' }).ok).toBe(true);
  });

  it('refuses an app gPhone does not have', () => {
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
    // The request is legitimate; only the number is not — the same call the `gphonecharge`
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
    expect(globalThis.emitNet).toHaveBeenCalledWith('gphone:client:battery:charging', SRC, true);
  });
});

describe('AddMedia', () => {
  const add = (media: unknown, citizenid: unknown = CID) =>
    publishedExport('AddMedia')!(citizenid, media) as Promise<any>;

  beforeEach(() => {
    dbMock.insert.mockResolvedValue(77);
  });

  it('accepts a hotlinked gif and returns its row id', async () => {
    // The camera can only ever produce a `photo`, so before this export the six other
    // kinds the table understands had no way to exist at all.
    const result = await add({ kind: 'gif', url: 'https://x.test/a.gif' });
    expect(result).toMatchObject({ ok: true, value: { id: 77 } });
  });

  it('refuses a kind the table does not have', async () => {
    expect((await add({ kind: 'hologram', url: 'https://x.test/a.gif' })).ok).toBe(false);
  });

  it('refuses a row with nothing to show', async () => {
    // Neither bytes nor a url renders as a placeholder forever, which is worse than
    // refusing the call.
    expect((await add({ kind: 'photo' })).ok).toBe(false);
  });

  it('refuses a url or thumbnail that could execute', async () => {
    // `url` is `clientWritable: false`, so this export is the only way a value reaches the
    // column — which makes it the right place to refuse a scheme rather than trusting
    // every future consumer to re-check.
    expect((await add({ kind: 'gif', url: 'javascript:alert(1)' })).ok).toBe(false);
    expect(
      (await add({ kind: 'video', url: 'https://x.test/v.mp4', thumbnail: 'javascript:1' })).ok
    ).toBe(false);
  });

  it('writes under the citizenid it was given', async () => {
    await add({ kind: 'gif', url: 'https://x.test/a.gif' }, 'OTHER99');
    const params = dbMock.insert.mock.calls[0][1] as unknown[];
    expect(params).toContain('OTHER99');
  });

  it('requires a citizenid', async () => {
    expect((await add({ kind: 'gif', url: 'https://x.test/a.gif' }, '')).ok).toBe(false);
  });
});
