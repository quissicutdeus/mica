// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import {
  BRIDGES,
  endMarker,
  loadBridge,
  renderTable,
  rewriteReadme,
  startMarker
} from '../../scripts/lib/bridge-table.js';
import { BRIDGES_DIR, globToRegExp, manifestGlobs } from '../../scripts/lib/release-zip.js';

/**
 * The lb-phone and NPWD compatibility bridges (MICA-232).
 *
 * Each bridge is hand-written JavaScript that FiveM runs as plain scripts, so this suite
 * runs them the same way: `map.js`, `runtime.js` and one side's file, in manifest order, in
 * one fresh context with FiveM's globals stubbed. What no suite can check is the game: that
 * FiveM resolves `exports['lb-phone']` to this resource, that a Lua caller awaits a promise,
 * and that a script written against the real thing behaves the same against this.
 */

const ROOT = resolve(__dirname, '../..');
const bridgeFile = (bridge: string, file: string) =>
  readFileSync(join(ROOT, 'bridges', bridge, file), 'utf8');

/** The names micaOS publishes on one side, read from the source that publishes them. */
const published = (file: string): string[] =>
  [...readFileSync(join(ROOT, file), 'utf8').matchAll(/publish\(\s*'(\w+)'/g)].map((m) => m[1]);
const SERVER_EXPORTS = published('server/lib/publicApi.ts');
const CLIENT_EXPORTS = published('client/lib/publicApi.ts');

/** What the ticket says each bridge must answer to. Any side, mapped or stubbed. */
const REQUIRED: Record<string, string[]> = {
  'lb-phone': [
    'SendMessage',
    'SendNotification',
    'SendMail',
    'AddContact',
    'GetEquippedPhoneNumber',
    'GetSourceFromNumber',
    'CreateCall',
    'IsInCall',
    'HasPhoneItem'
  ],
  npwd: [
    'openApp',
    'setPhoneVisible',
    'isPhoneVisible',
    'setPhoneDisabled',
    'getPhoneNumber',
    'getPlayerData',
    'createNotification',
    'createSystemNotification',
    'startPhoneCall',
    'isInCall'
  ]
};

type Entry = {
  name: string;
  side: 'server' | 'client';
  uses: string[];
  note: string;
  fallback: unknown;
  run?: Function;
};

const ok = (value?: unknown) => ({ ok: true, value });
const fail = (reason = 'unknown_player') => ({ ok: false, reason, message: reason });

/**
 * Load one side of a bridge as FiveM would, against a `mica` whose exports are the given
 * stubs. A name not given is absent, as `exports.mica.Missing` is in FiveM -- calling it
 * throws, which is exactly the case the bridge has to survive.
 */
const load = (bridge: string, side: 'server' | 'client', mica: Record<string, Function> = {}) => {
  const registered = new Map<string, Function>();
  const exportsFn = Object.assign((name: string, fn: Function) => registered.set(name, fn), {
    mica
  });
  const handlers = new Map<string, Function>();
  const warn = vi.fn();
  const emitNet = vi.fn();
  const context = createContext({
    exports: exportsFn,
    console: { warn, log: vi.fn(), error: vi.fn() },
    emitNet,
    onNet: (name: string, fn: Function) => handlers.set(name, fn),
    on: (name: string, fn: Function) => handlers.set(name, fn),
    GetInvokingResource: () => 'my-dispatch',
    source: 0,
    Date,
    Promise
  });
  for (const file of ['map.js', 'runtime.js', `${side}.js`]) {
    runInContext(bridgeFile(bridge, file), context, { filename: `bridges/${bridge}/${file}` });
  }
  const call = (name: string, ...args: unknown[]) => {
    const fn = registered.get(name);
    if (!fn) throw new Error(`${bridge} ${side} did not register ${name}`);
    return fn(...args);
  };
  return { registered, handlers, warn, emitNet, call, context };
};

const entriesOf = (bridge: string): Entry[] => loadBridge(ROOT, bridge).entries;

describe.each<string>(BRIDGES)('the %s bridge', (bridge: string) => {
  const entries = entriesOf(bridge);

  it('is one resource directory named for what it answers to', () => {
    expect(readdirSync(join(ROOT, 'bridges', bridge)).sort()).toEqual([
      'client.js',
      'fxmanifest.lua',
      'map.js',
      'runtime.js',
      'server.js'
    ]);
    expect(loadBridge(ROOT, bridge).resource).toBe(bridge);
  });

  it('declares its dependency on mica and the micaOS features it needs', () => {
    const manifest = bridgeFile(bridge, 'fxmanifest.lua');
    expect(manifest).toMatch(/^dependency 'mica'$/m);
    expect(manifest).toMatch(new RegExp(`^name '${bridge}'$`, 'm'));
    for (const key of ['MICA-223', 'MICA-224', 'MICA-226']) expect(manifest).toContain(key);
    // The table before the registrar before the side, in one context.
    expect(manifest.indexOf("'map.js'")).toBeLessThan(manifest.indexOf("'runtime.js'"));
    expect(manifest).toMatch(/^server_script 'server\.js'$/m);
    expect(manifest).toMatch(/^client_script 'client\.js'$/m);
  });

  it('carries an SPDX header on every file', () => {
    for (const file of readdirSync(join(ROOT, 'bridges', bridge))) {
      expect(bridgeFile(bridge, file), file).toContain(
        'SPDX-License-Identifier: AGPL-3.0-or-later'
      );
    }
  });

  it('lists every entry once per side, each complete', () => {
    const keys = entries.map((e) => `${e.side}:${e.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of entries) {
      expect(['server', 'client'], entry.name).toContain(entry.side);
      expect(Array.isArray(entry.uses), entry.name).toBe(true);
      expect(typeof entry.note, entry.name).toBe('string');
      if (entry.uses.length > 0) expect(typeof entry.run, entry.name).toBe('function');
      // A stub's note is the whole of what an owner learns, so it has to say something.
      else expect(entry.note.trim(), entry.name).not.toBe('');
    }
  });

  it('answers to every name the ticket lists', () => {
    const names = new Set(entries.map((e) => e.name));
    for (const name of REQUIRED[bridge]) expect(names, name).toContain(name);
  });

  it('reaches only exports micaOS publishes, on the side it reaches them', () => {
    for (const entry of entries) {
      for (const target of entry.uses) {
        const [side, name] = target.includes(':')
          ? (target.split(':') as ['server' | 'client', string])
          : [entry.side, target];
        const list = side === 'server' ? SERVER_EXPORTS : CLIENT_EXPORTS;
        expect(list, `${bridge} ${entry.side} ${entry.name} -> ${target}`).toContain(name);
      }
    }
  });

  it.each(['server', 'client'] as const)('registers every %s entry, and nothing else', (side) => {
    const { registered } = load(bridge, side);
    expect([...registered.keys()].sort()).toEqual(
      entries
        .filter((e) => e.side === side)
        .map((e) => e.name)
        .sort()
    );
  });

  it.each(['server', 'client'] as const)(
    'stubs a %s name with no equivalent: logs once, answers the fallback, never throws',
    (side) => {
      for (const entry of entries.filter((e) => e.side === side && e.uses.length === 0)) {
        const { call, warn } = load(bridge, side);
        expect(() => call(entry.name, 1, 'x')).not.toThrow();
        expect(call(entry.name)).toBe(entry.fallback);
        expect(warn, entry.name).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(entry.name);
        expect(warn.mock.calls[0][0]).toContain(entry.note);
      }
    }
  );

  it.each(['server', 'client'] as const)(
    'answers the fallback when micaOS is missing or throws, rather than throwing (%s)',
    async (side) => {
      const throwing = new Proxy(
        {},
        {
          get: () => () => {
            throw new Error('mica is not started');
          }
        }
      );
      for (const entry of entries.filter((e) => e.side === side && e.uses.length > 0)) {
        for (const mica of [{}, throwing]) {
          const { call } = load(bridge, side, mica as Record<string, Function>);
          let result: unknown;
          expect(() => (result = call(entry.name, 1, '5550100', {}))).not.toThrow();
          // `startPhoneCall`/`CreateCall` on the client reach no mica export, only `emitNet`.
          if (!entry.uses.every((u) => u.startsWith('server:'))) {
            expect(await result, `${entry.name}`).toEqual(entry.fallback);
          }
        }
      }
    }
  );

  it('shares the registrar and both sides byte-for-byte with every other bridge', () => {
    for (const file of ['runtime.js', 'server.js', 'client.js']) {
      expect(bridgeFile(bridge, file), file).toBe(bridgeFile(BRIDGES[0], file));
    }
  });

  it('relays a client-side call to CreateCall as the sender only, at most every two seconds', async () => {
    const CreateCall = vi.fn(() => ok());
    const server = load(bridge, 'server', { CreateCall });
    const client = load(bridge, 'client');
    const entry = entries.find((e) => e.side === 'client' && e.uses.includes('server:CreateCall'));
    expect(entry).toBeDefined();

    const arg = bridge === 'lb-phone' ? { number: '5550100' } : '5550100';
    client.call(entry!.name, arg);
    const [event, number] = client.emitNet.mock.calls[0];
    const handler = server.handlers.get(event);
    expect(handler).toBeDefined();

    server.context.source = 7;
    handler!(number);
    handler!(number);
    await Promise.resolve();
    await Promise.resolve();
    expect(CreateCall).toHaveBeenCalledTimes(1);
    expect(CreateCall).toHaveBeenCalledWith(7, '5550100');

    // Garbage is dropped before it reaches micaOS.
    server.context.source = 8;
    handler!({ number: '1' });
    handler!('x'.repeat(21));
    await Promise.resolve();
    expect(CreateCall).toHaveBeenCalledTimes(1);
  });
});

describe('lb-phone server calls, translated', () => {
  const directory = {
    GetCitizenId: vi.fn(async (n: string) => (n === '5550100' ? ok('CID1') : fail())),
    GetCitizenIdFromSource: vi.fn(async (s: number) => (s === 3 ? ok('CID1') : fail())),
    GetPhoneNumber: vi.fn(async (c: string) => (c === 'CID1' ? ok('5550100') : fail()))
  };

  it('SendMessage texts the holder of `to` from the line `from`, and answers ids', async () => {
    const SendMessage = vi.fn(async () => ok({ conversationId: 4, messageId: 9, delivered: true }));
    const cb = vi.fn();
    const { call } = load('lb-phone', 'server', { ...directory, SendMessage });

    await expect(
      call('SendMessage', '911', '5550100', 'hello', ['https://i.example/a.png'], cb)
    ).resolves.toEqual({ channelId: 4, messageId: 9 });
    expect(SendMessage).toHaveBeenCalledWith('CID1', {
      from: { number: '911' },
      body: 'hello\nhttps://i.example/a.png'
    });
    expect(cb).toHaveBeenCalledWith(true);

    await expect(call('SendMessage', '911', '0000000', 'hi', undefined, cb)).resolves.toBeNull();
    expect(cb).toHaveBeenLastCalledWith(false);
  });

  it('SendNotification takes a source or a number and groups under the caller', async () => {
    const SendNotification = vi.fn(() => ok({ delivered: true }));
    const { call } = load('lb-phone', 'server', { ...directory, SendNotification });

    await expect(
      call('SendNotification', 3, { app: 'Garage', title: 'Car ready', content: 'Bay 2' })
    ).resolves.toBe(true);
    expect(SendNotification).toHaveBeenCalledWith('CID1', {
      app: 'ext_my_dispatch',
      sourceLabel: 'Garage',
      title: 'Car ready',
      body: 'Bay 2',
      avatar: undefined
    });

    await expect(call('SendNotification', '5550100', { title: 'T' })).resolves.toBe(true);
    expect(SendNotification).toHaveBeenLastCalledWith(
      'CID1',
      expect.objectContaining({ sourceLabel: 'my-dispatch', title: 'T', body: '' })
    );
    await expect(call('SendNotification', 99, { title: 'T' })).resolves.toBeNull();
  });

  it('SendNotification reads the caller before it yields, while FiveM still names it', async () => {
    const SendNotification = vi.fn(() => ok({ delivered: true }));
    const { call, context } = load('lb-phone', 'server', { ...directory, SendNotification });
    // FiveM answers the invoking resource only during the synchronous part of the call.
    let onStack = false;
    context.GetInvokingResource = () => (onStack ? 'my-dispatch' : '');

    onStack = true;
    const pending = call('SendNotification', 3, { title: 'T' });
    onStack = false;

    await expect(pending).resolves.toBe(true);
    expect(SendNotification).toHaveBeenCalledWith(
      'CID1',
      expect.objectContaining({ app: 'ext_my_dispatch', sourceLabel: 'my-dispatch' })
    );
  });

  it('SendMail reaches a phone number or a citizenid, and refuses an address', async () => {
    const SendSystemEmail = vi.fn(async () => ({ id: 1 }));
    const { call } = load('lb-phone', 'server', { ...directory, SendSystemEmail });
    const mail = { sender: 'Bank', subject: 'Statement', message: 'Hi' };

    await expect(call('SendMail', { ...mail, to: '5550100' })).resolves.toBe(true);
    await expect(call('SendMail', { ...mail, to: 'CID1' })).resolves.toBe(true);
    expect(SendSystemEmail).toHaveBeenCalledWith('CID1', {
      sender: 'Bank',
      subject: 'Statement',
      content: 'Hi'
    });
    await expect(call('SendMail', { ...mail, to: 'x@lbphone.com' })).resolves.toBe(false);
    expect(SendSystemEmail).toHaveBeenCalledTimes(2);
  });

  it('AddContact writes to the owner of phoneNumber', async () => {
    const AddContact = vi.fn(async () => ok({ id: 1 }));
    const { call } = load('lb-phone', 'server', { ...directory, AddContact });

    await call('AddContact', '5550100', {
      number: '5559999',
      firstname: 'John',
      lastname: 'Doe',
      avatar: 'x',
      email: 'j@d'
    });
    expect(AddContact).toHaveBeenCalledWith('CID1', {
      firstname: 'John',
      lastname: 'Doe',
      phone: '5559999',
      email: 'j@d'
    });
  });

  it('GetEquippedPhoneNumber takes a source or a citizenid', async () => {
    const { call } = load('lb-phone', 'server', directory);
    await expect(call('GetEquippedPhoneNumber', 3)).resolves.toBe('5550100');
    await expect(call('GetEquippedPhoneNumber', '3')).resolves.toBe('5550100');
    await expect(call('GetEquippedPhoneNumber', 'CID1')).resolves.toBe('5550100');
    await expect(call('GetEquippedPhoneNumber', 99)).resolves.toBeNull();
  });

  it('GetSourceFromNumber, CreateCall, IsInCall and HasPhoneItem unwrap to plain values', async () => {
    const mica = {
      GetSourceFromNumber: vi.fn(async (n: string) => (n === '5550100' ? ok(3) : fail('offline'))),
      CreateCall: vi.fn(async () => ok()),
      IsInCall: vi.fn((s: number) => (s === 3 ? ok(true) : fail())),
      HasPhoneItem: vi.fn((s: number) => (s === 3 ? ok(true) : ok(false)))
    };
    const { call } = load('lb-phone', 'server', mica);

    await expect(call('GetSourceFromNumber', '5550100')).resolves.toBe(3);
    await expect(call('GetSourceFromNumber', '0')).resolves.toBeNull();
    await expect(
      call('CreateCall', { source: 3, phoneNumber: 'ignored' }, '5559999', { hideNumber: true })
    ).resolves.toBe(true);
    expect(mica.CreateCall).toHaveBeenCalledWith(3, '5559999');
    expect(call('IsInCall', 3)).toBe(true);
    expect(call('IsInCall', 4)).toBe(false);
    expect(call('HasPhoneItem', 3, '5550100')).toBe(true);
    expect(call('HasPhoneItem', 4)).toBe(false);
  });
});

describe('lb-phone client calls, translated', () => {
  it('drives the device the way lb-phone names it', () => {
    const mica = {
      IsPhoneOpen: vi.fn(() => ok(true)),
      OpenPhone: vi.fn(() => ok()),
      ClosePhone: vi.fn(() => ok()),
      TogglePhone: vi.fn(() => ok({ open: true })),
      IsPhoneEnabled: vi.fn(() => ok(false)),
      SetPhoneEnabled: vi.fn(() => ok()),
      OpenApp: vi.fn(() => ok()),
      Notify: vi.fn(() => ok()),
      GetPhoneNumber: vi.fn(() => ok('5550100')),
      IsInCall: vi.fn(() => ok(true))
    };
    const { call } = load('lb-phone', 'client', mica);

    expect(call('IsOpen')).toBe(true);
    call('ToggleOpen', true);
    call('ToggleOpen', false);
    call('ToggleOpen');
    expect(mica.OpenPhone).toHaveBeenCalledTimes(1);
    expect(mica.ClosePhone).toHaveBeenCalledTimes(1);
    expect(mica.TogglePhone).toHaveBeenCalledTimes(1);
    expect(call('IsDisabled')).toBe(true);
    call('ToggleDisabled', true);
    expect(mica.SetPhoneEnabled).toHaveBeenCalledWith(false);
    call('OpenApp', 'Messages', { id: 1 });
    expect(mica.OpenApp).toHaveBeenCalledWith('messages', { id: 1 });
    call('SendNotification', { app: 'Settings', title: 'Test', content: 'Body' });
    expect(mica.Notify).toHaveBeenCalledWith({ type: 'info', title: 'Test', message: 'Body' });
    expect(call('GetEquippedPhoneNumber')).toBe('5550100');
    expect(call('IsInCall')).toBe(true);
  });
});

describe('NPWD calls, translated', () => {
  it('getPlayerData finds a player by source, identifier or phone number', async () => {
    const mica = {
      GetCitizenId: vi.fn(async (n: string) => (n === '5550100' ? ok('CID1') : fail())),
      GetCitizenIdFromSource: vi.fn(async (s: number) => (s === 3 ? ok('CID1') : fail())),
      GetPhoneNumber: vi.fn(async (c: string) => (c === 'CID1' ? ok('5550100') : fail()))
    };
    const { call } = load('npwd', 'server', mica);
    const expected = {
      phoneNumber: '5550100',
      identifier: 'CID1',
      firstName: null,
      lastName: null,
      name: null
    };

    await expect(call('getPlayerData', { source: 3 })).resolves.toEqual(expected);
    await expect(call('getPlayerData', { identifier: 'CID1' })).resolves.toEqual(expected);
    await expect(call('getPlayerData', { phoneNumber: '5550100' })).resolves.toEqual(expected);
    await expect(call('getPlayerData', { source: 9 })).resolves.toBeNull();
  });

  it('emitMessage and the busy checks reach SendMessage and IsInCall', async () => {
    const mica = {
      GetCitizenId: vi.fn(async () => ok('CID1')),
      SendMessage: vi.fn(async () => ok({ conversationId: 1, messageId: 1, delivered: true })),
      GetSourceFromNumber: vi.fn(async (n: string) => (n === '5550100' ? ok(3) : fail())),
      IsInCall: vi.fn((s: number) => ok(s === 3))
    };
    const { call } = load('npwd', 'server', mica);

    await call('emitMessage', { senderNumber: '911', targetNumber: '5550100', message: 'PD' });
    expect(mica.SendMessage).toHaveBeenCalledWith('CID1', { from: { number: '911' }, body: 'PD' });
    expect(call('isPlayerBusy', 3)).toBe(true);
    await expect(call('isPhoneNumberBusy', '5550100')).resolves.toBe(true);
    await expect(call('isPhoneNumberBusy', '0')).resolves.toBe(false);
  });

  it('drives the device and raises toasts the way NPWD names them', () => {
    const mica = {
      OpenApp: vi.fn(() => ok()),
      OpenPhone: vi.fn(() => ok()),
      ClosePhone: vi.fn(() => ok()),
      IsPhoneOpen: vi.fn(() => ok(false)),
      SetPhoneEnabled: vi.fn(() => ok()),
      IsPhoneEnabled: vi.fn(() => ok(true)),
      GetPhoneNumber: vi.fn(() => fail('not_ready')),
      Notify: vi.fn(() => ok()),
      IsInCall: vi.fn(() => ok(false))
    };
    const { call } = load('npwd', 'client', mica);

    call('openApp', 'CONTACTS');
    expect(mica.OpenApp).toHaveBeenCalledWith('contacts');
    call('setPhoneVisible', true);
    call('setPhoneVisible', false);
    expect(mica.OpenPhone).toHaveBeenCalledTimes(1);
    expect(mica.ClosePhone).toHaveBeenCalledTimes(1);
    expect(call('isPhoneVisible')).toBe(false);
    call('setPhoneDisabled', true);
    expect(mica.SetPhoneEnabled).toHaveBeenCalledWith(false);
    expect(call('isPhoneDisabled')).toBe(false);
    expect(call('getPhoneNumber')).toBeNull();
    call('createNotification', { appId: 'TWITTER', secondaryTitle: 'Bot', content: 'Hi' });
    expect(mica.Notify).toHaveBeenCalledWith({ type: 'info', title: 'Bot', message: 'Hi' });
    call('createSystemNotification', { uniqId: 'x', secondaryTitle: 'Survey', content: 'Q?' });
    expect(mica.Notify).toHaveBeenLastCalledWith({ type: 'info', title: 'Survey', message: 'Q?' });
    expect(call('isInCall')).toBe(false);
  });
});

describe('the bridges in the release zip', () => {
  it('ship under the resource, where FiveM will not start them on its own', () => {
    expect(BRIDGES_DIR).toBe('bridges');
    const packer = readFileSync(join(ROOT, 'scripts/pack-resource.js'), 'utf8');
    expect(packer).toContain('walk(BRIDGES_DIR)');
  });

  it("are not declared by micaOS's own manifest, so it neither loads nor serves them", () => {
    const generator = readFileSync(join(ROOT, 'scripts/generate-barrels.js'), 'utf8');
    const template = /const manifest = `([\s\S]*?)`;/.exec(generator)?.[1] ?? '';
    const globs = manifestGlobs(template);
    expect(globs.length).toBeGreaterThan(0);
    for (const bridge of BRIDGES) {
      for (const file of readdirSync(join(ROOT, 'bridges', bridge))) {
        const path = `bridges/${bridge}/${file}`;
        for (const glob of globs)
          expect(globToRegExp(glob).test(path), `${glob} ${path}`).toBe(false);
      }
    }
  });
});

describe("README's bridge tables", () => {
  it('list every entry of each bridge, stubs included', () => {
    for (const bridge of BRIDGES) {
      const table = renderTable(bridge, loadBridge(ROOT, bridge));
      for (const entry of entriesOf(bridge)) expect(table).toContain(`| \`${entry.name}\` |`);
      expect(table).toContain('none -- logs once');
    }
  });

  it('are rewritten between the markers, and a second run changes nothing', async () => {
    const readme = BRIDGES.map(
      (b: string) => `## ${b}\n\n${startMarker(b)}\nstale\n${endMarker(b)}\n`
    ).join('\n');
    const once = await rewriteReadme(ROOT, readme);
    expect(once).not.toContain('stale');
    expect(once).toMatch(/\| `SendMessage` +\| server +\|/);
    expect(await rewriteReadme(ROOT, once)).toBe(once);
  });

  it('refuse a README with a marker missing, rather than passing on nothing', async () => {
    await expect(rewriteReadme(ROOT, 'no markers here')).rejects.toThrow(/must carry/);
    const onlyOne = `${startMarker('lb-phone')}\n${endMarker('lb-phone')}\n`;
    await expect(rewriteReadme(ROOT, onlyOne)).rejects.toThrow(/bridge:npwd:start/);
  });
});
