import { describe, it, expect, vi, beforeEach } from 'vitest';

const { transport } = vi.hoisted(() => ({ transport: { send: vi.fn(), on: vi.fn() } }));
vi.mock('./transport', () => ({ getTransport: () => transport }));

import { fetchNui } from './fetchNui';

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
});
