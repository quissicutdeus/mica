// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { transport } = vi.hoisted(() => ({ transport: { send: vi.fn(), on: vi.fn() } }));
vi.mock('./transport', () => ({ getTransport: () => transport }));

import { fetchNui } from './fetchNui';
import { isRefusal, ServiceRefusal } from '@mica/sdk';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import { setActiveDevice } from '../shell/state/device';

/**
 * The contract is decided by `defaultValue`: supplied means "never throw, give me this
 * instead"; omitted means "throw, I need to know".
 *
 * This used to swallow everything and return `null`, with two consequences worth pinning
 * down. Every `try/catch` in every store was unreachable, and an error reply came back
 * as data — `contacts.add` pushed `{ error: 'Player not authenticated' }` into the
 * contact list and reported success.
 *
 * The transport is mocked so failures can actually be provoked; the previous tests went
 * through the browser mock registry and could only ever exercise the happy path.
 */

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('without a defaultValue — writes', () => {
  it('returns the reply', async () => {
    transport.send.mockResolvedValue({ id: 1 });
    await expect(fetchNui('createNote', {})).resolves.toEqual({ id: 1 });
  });

  it('throws when the transport fails', async () => {
    transport.send.mockRejectedValue(new Error('NUI unreachable'));
    await expect(fetchNui('createNote', {})).rejects.toThrow('NUI unreachable');
  });

  it('throws on a server error reply rather than returning it as data', async () => {
    // The exact shape `ServiceEndpoint` sends for an unauthenticated caller.
    transport.send.mockResolvedValue({ error: 'Player not authenticated' });
    await expect(fetchNui('createNote', {})).rejects.toThrow('Player not authenticated');
  });

  it('throws on the client-side 15s timeout reply', async () => {
    transport.send.mockResolvedValue({ error: 'Request timed out' });
    await expect(fetchNui('getNotes')).rejects.toThrow('Request timed out');
  });

  it('wraps a non-Error rejection', async () => {
    transport.send.mockRejectedValue('just a string');
    await expect(fetchNui('createNote', {})).rejects.toThrow('just a string');
  });

  it('does not mistake ordinary data for an error envelope', async () => {
    // A row could legitimately carry a field called `error`, and an empty string is not
    // a failure.
    transport.send.mockResolvedValue({ id: 1, error: '' });
    await expect(fetchNui('createNote', {})).resolves.toMatchObject({ id: 1 });

    transport.send.mockResolvedValue({ error: 404 });
    await expect(fetchNui('createNote', {})).resolves.toMatchObject({ error: 404 });
  });
});

describe('with a defaultValue — reads', () => {
  it('returns the default when the transport fails', async () => {
    transport.send.mockRejectedValue(new Error('boom'));
    await expect(fetchNui('getNotes', null, { defaultValue: [] })).resolves.toEqual([]);
  });

  it('returns the default on an error reply, and never throws', async () => {
    transport.send.mockResolvedValue({ error: 'Not authorised.' });
    await expect(fetchNui('getReportQueue', {}, { defaultValue: [] })).resolves.toEqual([]);
  });

  it('returns the default for null or undefined', async () => {
    transport.send.mockResolvedValue(null);
    await expect(fetchNui('getNotes', null, { defaultValue: [] })).resolves.toEqual([]);
  });

  it('returns the default when an array was expected and something else arrived', async () => {
    transport.send.mockResolvedValue({ nope: true });
    await expect(fetchNui('getNotes', null, { defaultValue: [] })).resolves.toEqual([]);
  });

  it('passes real data through', async () => {
    transport.send.mockResolvedValue([{ id: 1 }]);
    await expect(fetchNui('getNotes', null, { defaultValue: [] })).resolves.toEqual([{ id: 1 }]);
  });

  it('quiet suppresses the console warning on a transport failure', async () => {
    transport.send.mockRejectedValue(new Error('boom'));
    await fetchNui('getSettings', null, { defaultValue: [], quiet: true });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('quiet suppresses the console warning on an error reply', async () => {
    transport.send.mockResolvedValue({ error: 'Player not authenticated' });
    await fetchNui('getSettings', null, { defaultValue: [], quiet: true });
    expect(console.warn).not.toHaveBeenCalled();
  });
});

/**
 * MICA-216: an error reply may carry a message key beside its English text. The key wins
 * when the shell's `server` catalog knows it, so the toast reads in the phone's language;
 * an unknown key — an add-on's own server half — falls back to the English that was sent.
 */
describe('a keyed error reply', () => {
  it('resolves the key through the catalog, with params', async () => {
    const { registerMessages, locale } = await import('../../../sdk/i18n');
    registerMessages('server', {
      en: { 'probe.refused': 'No, {name}.' },
      de: { 'probe.refused': 'Nein, {name}.' }
    });
    locale.set('de');
    transport.send.mockResolvedValueOnce({
      error: 'No, Trevor.',
      key: 'server.probe.refused',
      params: { name: 'Trevor' }
    });
    await expect(fetchNui('x')).rejects.toThrow('Nein, Trevor.');
    locale.set('en');
  });

  it('falls back to the English text for a key the catalog does not know', async () => {
    transport.send.mockResolvedValueOnce({ error: 'Plain English', key: 'server.nowhere' });
    await expect(fetchNui('x')).rejects.toThrow('Plain English');
  });
});

/**
 * MICA-310: the key is kept on what is thrown, so an app tells one refusal from another by
 * the key rather than by text a translator is free to reword.
 */
describe('a refusal keeps its key', () => {
  const caught = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => expect.unreachable('expected a rejection'),
      (error: unknown) => error
    );

  it('throws a ServiceRefusal carrying the key beside the translated message', async () => {
    const { registerMessages, locale } = await import('../../../sdk/i18n');
    registerMessages('server', {
      en: { 'probe.keyed': 'Not for you, {name}.' },
      de: { 'probe.keyed': 'Nicht für dich, {name}.' }
    });
    locale.set('de');
    transport.send.mockResolvedValueOnce({
      error: 'Not for you, Trevor.',
      key: 'server.probe.keyed',
      params: { name: 'Trevor' }
    });
    const error = await caught(fetchNui('x'));
    locale.set('en');

    expect(error).toBeInstanceOf(ServiceRefusal);
    expect(error).toBeInstanceOf(Error);
    expect((error as ServiceRefusal).key).toBe('server.probe.keyed');
    expect((error as ServiceRefusal).message).toBe('Nicht für dich, Trevor.');
    expect(isRefusal(error, 'server.probe.keyed')).toBe(true);
    expect(isRefusal(error, 'server.probe.other')).toBe(false);
  });

  it('still matches after the catalog rewords the entry', async () => {
    const { registerMessages } = await import('../../../sdk/i18n');
    registerMessages('server', { en: { 'probe.reworded': 'The first wording.' } });
    transport.send.mockResolvedValueOnce({ error: 'English', key: 'server.probe.reworded' });
    const before = await caught(fetchNui('x'));

    registerMessages('server', { en: { 'probe.reworded': 'Something else entirely.' } });
    transport.send.mockResolvedValueOnce({ error: 'English', key: 'server.probe.reworded' });
    const after = await caught(fetchNui('x'));

    expect((before as Error).message).toBe('The first wording.');
    expect((after as Error).message).toBe('Something else entirely.');
    expect(isRefusal(before, 'server.probe.reworded')).toBe(true);
    expect(isRefusal(after, 'server.probe.reworded')).toBe(true);
  });

  it('keeps the key the catalog does not know, with the English as the message', async () => {
    transport.send.mockResolvedValueOnce({ error: 'Plain English', key: 'server.nowhere' });
    const error = await caught(fetchNui('x'));
    expect(isRefusal(error, 'server.nowhere')).toBe(true);
    expect((error as Error).message).toBe('Plain English');
  });

  it('is not a refusal when the reply named no key, whatever its text', async () => {
    transport.send.mockResolvedValueOnce({ error: 'Request timed out' });
    const timeout = await caught(fetchNui('x'));
    expect(timeout).toBeInstanceOf(Error);
    expect(isRefusal(timeout)).toBe(false);

    // The exact English a keyed refusal would have carried, but no key: still not one.
    transport.send.mockResolvedValueOnce({ error: 'That line is not available to you.' });
    const unkeyed = await caught(fetchNui('x'));
    expect(isRefusal(unkeyed)).toBe(false);
    expect(isRefusal(unkeyed, 'server.jobs.lineUnavailable')).toBe(false);
  });

  it('is not a refusal for an error somebody hung a key property on', () => {
    const forged = Object.assign(new Error('x'), { key: 'server.jobs.lineUnavailable' });
    expect(isRefusal(forged)).toBe(false);
    expect(isRefusal(forged, 'server.jobs.lineUnavailable')).toBe(false);
    expect(isRefusal({ name: 'ServiceRefusal', key: 'server.generic', message: 'x' })).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });

  it('a read with a default still resolves to the default on a refusal', async () => {
    transport.send.mockResolvedValueOnce({ error: 'English', key: 'server.probe.uncatalogued' });
    await expect(fetchNui('x', null, { defaultValue: [] })).resolves.toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      "fetchNui('x') returned an error; using the default.",
      'English'
    );
  });
});

/**
 * MICA-264: a phone and a tablet are two identities, and the generic envelope is how a
 * request says which one it speaks for. `fetchNui` is the one door every generic request
 * goes through, so it stamps the device on screen there.
 */
describe('the generic envelope names its device', () => {
  afterEach(() => setActiveDevice('phone'));

  it('carries the active device when the caller named none', async () => {
    transport.send.mockResolvedValue([]);
    setActiveDevice('tablet');
    await fetchNui(GENERIC_SERVICE_ACTION, { service: 'notes', action: 'get' });
    expect(transport.send).toHaveBeenCalledWith(GENERIC_SERVICE_ACTION, {
      service: 'notes',
      action: 'get',
      device: 'tablet'
    });
  });

  it('reads the device when the request is sent, not when the caller was built', async () => {
    transport.send.mockResolvedValue([]);
    const payload = { service: 'notes', action: 'get' };
    await fetchNui(GENERIC_SERVICE_ACTION, payload);
    setActiveDevice('tablet');
    await fetchNui(GENERIC_SERVICE_ACTION, payload);
    expect(transport.send.mock.calls.map(([, data]) => data.device)).toEqual(['phone', 'tablet']);
    // The caller's own object is left as it was.
    expect(payload).toEqual({ service: 'notes', action: 'get' });
  });

  it('leaves an explicit device alone, even when another is on screen', async () => {
    transport.send.mockResolvedValue({ ok: true });
    setActiveDevice('tablet');
    await fetchNui(GENERIC_SERVICE_ACTION, {
      service: 'settings',
      action: 'set',
      data: { app: 'settings', key: 'theme', value: '"dark"' },
      device: 'phone'
    });
    expect(transport.send.mock.calls[0][1].device).toBe('phone');
  });

  it('does not touch a named route, which the client stamps itself', async () => {
    transport.send.mockResolvedValue(null);
    setActiveDevice('tablet');
    await fetchNui('setTyping', { typing: true });
    expect(transport.send).toHaveBeenCalledWith('setTyping', { typing: true });
  });
});
