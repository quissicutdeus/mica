// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. The iframe twins, because the
 * mock is installed inside a sandboxed add-on's frame — and, for the parity cases, the shell's
 * own `IframeHostServer` and `service` facet, so the real path an answer takes is the real one.
 */
import './registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  addonError,
  addonOutput,
  defineAddonMock,
  defineAddonService,
  type AddonHandlers
} from '@mica/shared/addonService';
import { MICA_ADDON_MOCK_MARKER } from '@mica/shared/addonDev';
import { fakeTransport } from './__fixtures__/fakeTransport';
import { service } from './facets/service';
import { appEvents } from './facets/appEvents';
import { installAddonMock, resetAddonMocksForTest } from './devMock';
import type { ToFrame, ToShell } from './messages';
import { useService } from '../useService';
import { useAppEvents } from '../useAppEvents';
import { registerFacet, registerHost, resetHostsForTest } from '../current';
import { createInProcessHost } from '../inProcess/createInProcessHost';
import { defineApp } from '../../manifest';
import type { AppEvent } from '../../vocabulary/shell';
import { createIframeHostServer } from '../../../web/src/shell/addon/IframeHostServer';
import { resetGrantsForTest } from '../../../web/src/shell/state/addOnGrants';
import { service as shellService } from '../../../web/src/host/facets/service';
import { setTransport } from '../../../web/src/nui/transport';
import { isRefusal, ServiceRefusal } from '../../lib/errors';

interface Note {
  id: number;
  text: string;
  created: string;
}

const notes = defineAddonService({
  id: 'probe',
  actions: {
    list: { input: {}, output: addonOutput<Note[]>() },
    add: { input: { text: { type: 'string', min: 1, max: 20 } }, output: addonOutput<Note>() },
    remove: { input: { id: { type: 'integer', min: 1 } } },
    boom: { input: {} },
    bad: { input: {} }
  }
});

/** What each handler was called with, so a test can tell whether it ran at all. */
const seen: { action: string; citizenid: string; input: unknown; source: number }[] = [];

const rows: Note[] = [];

const mock = defineAddonMock(notes, ({ push }) => ({
  list: (citizenid, input, source) => {
    seen.push({ action: 'list', citizenid, input, source });
    return rows;
  },
  add: (citizenid, input, source) => {
    seen.push({ action: 'add', citizenid, input, source });
    const row = { id: rows.length + 1, text: input.text, created: new Date(0) as never };
    rows.push(row);
    push('added', { id: row.id });
    return row;
  },
  remove: (citizenid, input, source) => {
    seen.push({ action: 'remove', citizenid, input, source });
    return addonError('That   note\n is not yours.');
  },
  boom: () => {
    throw new Error('the handler broke');
  },
  bad: () => ({ error: 'not a message table' })
}));

/** The add-on's own manifest, as far as which services it may call. */
const PROBE = { id: 'probe' };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The rejection a promise settles with, as the app would read it. */
const rejection = async (promise: Promise<unknown>): Promise<{ name: string; message: string }> => {
  try {
    await promise;
  } catch (error) {
    const e = error as Error;
    return { name: e.name, message: e.message };
  }
  throw new Error('expected a rejection');
};

let wire: ReturnType<typeof fakeTransport>;

beforeEach(() => {
  resetAddonMocksForTest();
  resetHostsForTest();
  resetGrantsForTest();
  // The iframe twins, every time: the shell facet module above registers itself on import,
  // and a parity case swaps it in.
  registerFacet('service', service);
  registerFacet('appEvents', appEvents);
  registerHost(createInProcessHost('probe', ['app-events']));
  wire = fakeTransport();
  seen.length = 0;
  rows.length = 0;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAddonMocksForTest();
});

describe('installAddonMock: answering', () => {
  it("answers the declaration's own id from the handlers, and sends nothing to the shell", async () => {
    installAddonMock(mock, PROBE);
    const row = await useService(notes).call('add', { text: 'hello' });
    expect(row).toMatchObject({ id: 1, text: 'hello' });
    expect(await useService(notes).call('list', {}, [])).toHaveLength(1);
    expect(wire.sent).toEqual([]);
  });

  it('calls the handler as a fixed dev citizen and source, with the parsed input', async () => {
    installAddonMock(mock, PROBE);
    await useService('probe').call('add', { text: 'x' });
    expect(seen).toEqual([
      { action: 'add', citizenid: 'DEV00001', input: { text: 'x' }, source: 1 }
    ]);
  });

  it('reads an absent input as {}, as the server does for an action taking nothing', async () => {
    installAddonMock(mock, PROBE);
    await useService(notes).call('list');
    expect(seen[0].input).toEqual({});
  });

  it('hands back a JSON copy: a Date arrives as a string and the mock state is not shared', async () => {
    installAddonMock(mock, PROBE);
    const row = await useService(notes).call('add', { text: 'x' });
    expect(row.created).toBe('1970-01-01T00:00:00.000Z');
    const list = await useService(notes).call('list', {}, []);
    list[0].text = 'changed';
    expect(rows[0].text).toBe('x');
  });

  it('logs that the mock is active, under the marker a production bundle is scanned for', () => {
    installAddonMock(mock, PROBE);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining(MICA_ADDON_MOCK_MARKER));
  });

  it('replaces an earlier mock for the same id', async () => {
    installAddonMock(mock, PROBE);
    installAddonMock(
      defineAddonMock(notes, () => ({
        list: () => [{ id: 9, text: 'second', created: '' }],
        add: () => ({ id: 0, text: '', created: '' }),
        remove: () => null,
        boom: () => null,
        bad: () => null
      })),
      PROBE
    );
    expect(await useService(notes).call('list', {}, [])).toEqual([
      { id: 9, text: 'second', created: '' }
    ]);
  });
});

describe('installAddonMock: refusing', () => {
  it('refuses input against the declaration before the handler runs', async () => {
    installAddonMock(mock, PROBE);
    const refused = await rejection(useService('probe').call('add', { text: 5 }));
    expect(refused.name).toBe('Error');
    expect(refused.message).toMatch(/text/);
    const unknownKey = await rejection(useService('probe').call('add', { text: 'x', extra: 1 }));
    expect(unknownKey.message).toMatch(/extra/);
    const tooLong = await rejection(useService('probe').call('add', { text: 'x'.repeat(21) }));
    expect(tooLong.message).toMatch(/text/);
    expect(seen).toEqual([]);
  });

  it('resolves to the default instead when the caller passed one', async () => {
    installAddonMock(mock, PROBE);
    expect(await useService('probe').call('add', { text: 5 }, 'fallback')).toBe('fallback');
    expect(seen).toEqual([]);
  });

  it("answers addonError's message, whitespace collapsed", async () => {
    installAddonMock(mock, PROBE);
    expect(await rejection(useService(notes).call('remove', { id: 1 }))).toEqual({
      name: 'Error',
      message: 'That note is not yours.'
    });
  });

  it('cuts a long addonError message to the same length the server does', async () => {
    installAddonMock(
      defineAddonMock(notes, () => ({
        list: () => [],
        add: () => addonError('y'.repeat(400)),
        remove: () => null,
        boom: () => null,
        bad: () => null
      })),
      PROBE
    );
    const { message } = await rejection(useService(notes).call('add', { text: 'x' }));
    expect(message).toHaveLength(160);
    expect(message.endsWith('…')).toBe(true);
  });

  it('answers the generic failure for a throw, a malformed error and an undeclared action', async () => {
    installAddonMock(mock, PROBE);
    // A `ServiceRefusal` keyed `server.generic`, as the real generic failure is (MICA-310).
    const generic = {
      name: 'ServiceRefusal',
      message: 'Something went wrong. Try again in a moment.'
    };
    expect(await rejection(useService(notes).call('boom'))).toEqual(generic);
    expect(await rejection(useService(notes).call('bad'))).toEqual(generic);
    expect(await rejection(useService('probe').call('nope', {}))).toEqual(generic);
    await expect(useService(notes).call('boom')).rejects.toSatisfy((error) =>
      isRefusal(error, 'server.generic')
    );
    // The cause goes to the console, where the server log would have had it.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('probe:boom threw'),
      expect.any(Error)
    );
  });

  it('settles a null answer, and a non-array where an array was the default, to the default', async () => {
    installAddonMock(
      defineAddonMock(notes, () => ({
        list: () => ({ not: 'a list' }) as never,
        add: () => null as never,
        remove: () => null,
        boom: () => null,
        bad: () => null
      })),
      PROBE
    );
    expect(await useService(notes).call('list', {}, [])).toEqual([]);
    expect(await useService('probe').call('add', { text: 'x' }, 'd')).toBe('d');
    expect(await useService('probe').call('add', { text: 'x' })).toBeNull();
  });
});

/**
 * The real path, end to end on this side of the server: the frame's iframe twin sends the
 * call, the shell's `IframeHostServer` hands it to the shell's own `service` facet, whose
 * `fetchNui` receives the reply `ServiceEndpoint` emits for a `PlayerFacingError` — and the
 * shell's answer is fed back into the frame. The mock must settle exactly as that does.
 */
describe('installAddonMock: { error } matches the real path', () => {
  type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };
  type Seen = { ok: true; value: unknown } | { ok: false; name: string; message: string };
  const seenAs = (settled: Settled): Seen => {
    if (settled.ok) return settled;
    const error = settled.error as Error;
    return { ok: false, name: error.name, message: error.message };
  };

  /** The frame's raw settlement, and the one reply the shell posted to get it there. */
  const crossWall = async (
    endpointReply: unknown,
    callArgs: [string, unknown?, unknown?]
  ): Promise<{ settled: Settled; posted: ToFrame }> => {
    registerFacet('service', service);
    const frame = fakeTransport();
    const pending = service('probe')
      .call(...callArgs)
      .then(
        (value): Settled => ({ ok: true, value }),
        (error: unknown): Settled => ({ ok: false, error })
      );
    const message = frame.sent[0] as Extract<ToShell, { kind: 'call' }>;

    // The shell's half, with the NUI transport answering what the server would have.
    registerFacet('service', shellService);
    setTransport({ send: () => Promise.resolve(endpointReply as never), on: () => () => {} });
    const posted: ToFrame[] = [];
    const guest = { postMessage: (m: ToFrame) => posted.push(m) };
    const server = createIframeHostServer({
      host: createInProcessHost('probe', []),
      manifest: defineApp({
        id: 'probe',
        name: 'Probe',
        icon: 'x',
        tile: { bg: 'bg-gray-900' },
        core: false,
        permissions: []
      }),
      props: {},
      guest: () => guest,
      onError: vi.fn(),
      onKey: vi.fn(),
      onTyping: vi.fn()
    });
    server.handle({ data: message, source: guest, origin: 'null' } as unknown as MessageEvent);
    for (let i = 0; i < 10 && posted.length === 0; i++) await tick();
    expect(posted).toHaveLength(1);
    frame.replies.get(message.id)?.(posted[0] as Extract<ToFrame, { kind: 'reply' }>);
    setTransport(null);
    registerFacet('service', service);
    return { settled: await pending, posted: posted[0] };
  };

  const realPath = async (
    endpointReply: unknown,
    callArgs: [string, unknown?, unknown?]
  ): Promise<Seen> => seenAs((await crossWall(endpointReply, callArgs)).settled);

  const mockSettled = async (callArgs: [string, unknown?, unknown?]): Promise<Settled> => {
    resetAddonMocksForTest();
    registerFacet('service', service);
    installAddonMock(mock, PROBE);
    return useService('probe')
      .call(...callArgs)
      .then(
        (value): Settled => ({ ok: true, value }),
        (error: unknown): Settled => ({ ok: false, error })
      );
  };

  const mockPath = async (callArgs: [string, unknown?, unknown?]): Promise<Seen> =>
    seenAs(await mockSettled(callArgs));

  // What `ServiceEndpoint` emits for the `PlayerFacingError` `answerFor` throws on
  // `addonError('That note is not yours.')`: the text, no key.
  const refusal = { error: 'That note is not yours.', key: undefined, params: undefined };

  it('rejects with the same name and message when no default was passed', async () => {
    const real = await realPath(refusal, ['remove', { id: 1 }]);
    expect(real).toEqual({ ok: false, name: 'Error', message: 'That note is not yours.' });
    expect(await mockPath(['remove', { id: 1 }])).toEqual(real);
  });

  it('resolves to the default in both when one was passed', async () => {
    const real = await realPath(refusal, ['remove', { id: 1 }, 'fallback']);
    expect(real).toEqual({ ok: true, value: 'fallback' });
    expect(await mockPath(['remove', { id: 1 }, 'fallback'])).toEqual(real);
  });

  it('settles a schema refusal the same way, the message being the first issue', async () => {
    // `SchemaError` carries no key, and its message is the first issue's.
    const real = await realPath({ error: 'text: expected a string.' }, ['add', { text: 5 }]);
    const mocked = await mockPath(['add', { text: 5 }]);
    expect(mocked.ok).toBe(false);
    expect(real.ok).toBe(false);
    if (!mocked.ok && !real.ok) expect(mocked.name).toBe(real.name);
  });

  /**
   * MICA-310. A keyed reply reaches the shell's `fetchNui` as a `ServiceRefusal`; the shell
   * posts its name, message and key and nothing else, and the frame rebuilds it — so an
   * add-on's `isRefusal(error, key)` answers exactly as a core app's does.
   */
  it('carries a refusal’s key across the wall, and nothing else of the error', async () => {
    const { settled, posted } = await crossWall(
      { error: 'Too many probe add requests. Slow down and try again.', key: 'server.rateLimited' },
      ['add', { text: 'x' }]
    );
    expect(settled.ok).toBe(false);
    const error = (settled as { ok: false; error: unknown }).error;
    expect(error).toBeInstanceOf(ServiceRefusal);
    expect(isRefusal(error, 'server.rateLimited')).toBe(true);
    expect(isRefusal(error, 'server.generic')).toBe(false);

    const reply = posted as Extract<ToFrame, { kind: 'reply'; ok: false }>;
    expect(Object.keys(reply.error).sort()).toEqual(['key', 'message', 'name']);
    expect(reply.error).toMatchObject({ name: 'ServiceRefusal', key: 'server.rateLimited' });
  });

  it('posts no key for a keyless refusal, so the frame sees a plain Error', async () => {
    const { settled, posted } = await crossWall(refusal, ['remove', { id: 1 }]);
    const error = (settled as { ok: false; error: unknown }).error;
    expect(isRefusal(error)).toBe(false);
    const reply = posted as Extract<ToFrame, { kind: 'reply'; ok: false }>;
    expect(Object.keys(reply.error).sort()).toEqual(['message', 'name']);
  });

  it('answers the generic failure as the same keyed refusal in both', async () => {
    const { settled: real } = await crossWall(
      { error: 'Something went wrong. Try again in a moment.', key: 'server.generic' },
      ['boom']
    );
    const mocked = await mockSettled(['boom']);
    for (const settled of [real, mocked]) {
      expect(settled.ok).toBe(false);
      expect(isRefusal((settled as { ok: false; error: unknown }).error, 'server.generic')).toBe(
        true
      );
    }
  });
});

describe('installAddonMock: pushes', () => {
  it("delivers a handler's push to useAppEvents(id) in the envelope a real push has", async () => {
    installAddonMock(mock, PROBE);
    const got: AppEvent[] = [];
    const any: AppEvent[] = [];
    useAppEvents('probe').on('added', (e) => got.push(e));
    useAppEvents('probe').onAny((e) => any.push(e));
    await useService(notes).call('add', { text: 'x' });
    expect(got).toEqual([]); // later, never inside the call that occasioned it
    await tick();
    expect(got).toEqual([
      { app: 'probe', event: 'added', payload: { id: 1 }, at: expect.any(Number), replayed: false }
    ]);
    expect(any).toEqual(got);
  });

  it('keeps the real subscription too, so a shell push still arrives', () => {
    installAddonMock(mock, PROBE);
    useAppEvents('probe').on('added', () => {});
    expect(wire.sent).toMatchObject([{ kind: 'call', facet: 'appEvents', member: 'on' }]);
  });

  it('holds a push nobody is listening for, and replays it on subscribe', async () => {
    const tools = installAddonMock(mock, PROBE);
    tools.push('later', { n: 1 });
    await tick();
    const got: AppEvent[] = [];
    useAppEvents('probe').on('later', (e) => got.push(e));
    expect(got).toMatchObject([{ event: 'later', payload: { n: 1 }, replayed: true }]);
  });

  it('stops delivering once unsubscribed', async () => {
    const tools = installAddonMock(mock, PROBE);
    const got: AppEvent[] = [];
    const off = useAppEvents('probe').on('added', (e) => got.push(e));
    off();
    tools.push('added', {});
    await tick();
    expect(got).toEqual([]);
  });

  it('refuses what the real push export refuses', () => {
    const tools = installAddonMock(mock, PROBE);
    expect(() => tools.push('Bad-Name')).toThrow(/lower_snake_case/);
    expect(() => tools.push('*')).toThrow(/lower_snake_case/);
    expect(() => tools.push('ok', [] as never)).toThrow(/plain object/);
    expect(() => tools.push('ok', { big: 'x'.repeat(20_000) })).toThrow(/16384 bytes/);
  });

  it("leaves another app's events to the real facet", () => {
    installAddonMock(mock, PROBE);
    useAppEvents('other').on('added', () => {});
    expect(wire.sent).toMatchObject([
      { kind: 'call', facet: 'appEvents', factoryArgs: ['other'], member: 'on' }
    ]);
  });
});

describe('installAddonMock: a foreign id', () => {
  it('falls through to the real twin, so the shell still refuses it', async () => {
    installAddonMock(mock, PROBE);
    void useService('contacts').call('list', {});
    expect(wire.sent).toMatchObject([
      { kind: 'call', facet: 'service', factoryArgs: ['contacts'], member: 'call' }
    ]);

    // And the shell answers that message as it always has.
    registerFacet('service', shellService);
    const posted: ToFrame[] = [];
    const guest = { postMessage: (m: ToFrame) => posted.push(m) };
    createIframeHostServer({
      host: createInProcessHost('probe', []),
      manifest: defineApp({
        id: 'probe',
        name: 'Probe',
        icon: 'x',
        tile: { bg: 'bg-gray-900' },
        core: false,
        permissions: []
      }),
      props: {},
      guest: () => guest,
      onError: vi.fn(),
      onKey: vi.fn(),
      onTyping: vi.fn()
    }).handle({ data: wire.sent[0], source: guest, origin: 'null' } as unknown as MessageEvent);
    await tick();
    expect(posted[0]).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("may only use its own service, not 'contacts'") }
    });
  });

  it('also falls through for a second service id the mock does not cover', () => {
    installAddonMock(mock, PROBE);
    void useService('probe_extra').call('list', {});
    expect(wire.sent).toMatchObject([{ facet: 'service', factoryArgs: ['probe_extra'] }]);
  });
});

describe('defineAddonMock', () => {
  it('takes the same handler type RegisterService does', () => {
    const handlers: AddonHandlers<typeof notes> = {
      list: () => [],
      add: (_c, { text }) => ({ id: 1, text, created: '' }),
      remove: () => null,
      boom: () => null,
      bad: () => null
    };
    expect(defineAddonMock(notes, () => handlers).declaration).toBe(notes);
  });

  it('refuses a declaration micaOS would refuse, with the reason', () => {
    expect(() =>
      defineAddonMock({ id: 'Bad Id', actions: { a: { input: {} } } }, () => ({ a: () => null }))
    ).toThrow(/defineAddonMock\('Bad Id'\).*not a service id/);
  });

  it('refuses a handler table that is not a function of the tools', () => {
    expect(() => defineAddonMock(notes, {} as never)).toThrow(/function of the tools/);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(mock)).toBe(true);
  });
});

describe('installAddonMock: only an id the phone lets this app call', () => {
  const declared = (id: string) => defineAddonService({ id, actions: { list: { input: {} } } });
  const mockOf = (id: string) => defineAddonMock(declared(id), () => ({ list: () => ['mocked'] }));

  it.each([
    ['its own id', 'probe', { id: 'probe' }],
    ['a second service under its prefix', 'probe_extra', { id: 'probe' }],
    [
      'an id its manifest lists in services',
      'shared_ledger',
      { id: 'probe', services: ['shared_ledger'] }
    ]
  ])('answers %s', async (_label, id, manifest) => {
    installAddonMock(mockOf(id), manifest);
    expect(await useService(id).call('list', {}, [])).toEqual(['mocked']);
    expect(wire.sent).toEqual([]);
  });

  it.each([
    [
      "another app's id",
      'contacts',
      { id: 'probe' },
      /allows only 'probe' and ids starting 'probe_'/
    ],
    ['an id that merely starts with the app id', 'prober', { id: 'probe' }, /allows only 'probe'/],
    [
      'its own id when services is declared without it',
      'probe',
      { id: 'probe', services: ['probe_extra'] },
      /lists in services \(probe_extra\)/
    ],
    [
      'a prefixed id when services is declared without it',
      'probe_other',
      { id: 'probe', services: ['probe_extra'] },
      /lists in services/
    ],
    ['anything when services is declared empty', 'probe', { id: 'probe', services: [] }, /\(none\)/]
  ])('throws at install for %s, as the phone would refuse it', (_label, id, manifest, reason) => {
    expect(() => installAddonMock(mockOf(id), manifest)).toThrow(reason);
    expect(() => installAddonMock(mockOf(id), manifest)).toThrow(/would refuse every call/);
  });

  it('leaves a refused id to the real twin, where the shell refuses it too', () => {
    expect(() => installAddonMock(mockOf('contacts'), PROBE)).toThrow();
    void useService('contacts').call('list', {});
    expect(wire.sent).toMatchObject([{ facet: 'service', factoryArgs: ['contacts'] }]);
  });

  it('refuses to install without a manifest to check against', () => {
    expect(() => installAddonMock(mock, undefined as never)).toThrow(/needs the add-on's manifest/);
  });
});
