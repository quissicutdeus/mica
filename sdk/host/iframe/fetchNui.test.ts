import { describe, it, expect } from 'vitest';
import { fetchNui } from './fetchNui';
import { fakeTransport } from './__fixtures__/fakeTransport';
import { GENERIC_SERVICE_ACTION } from '@shared/rpc';
import type { ToShell } from './messages';

describe('fetchNui', () => {
  it('refuses a named NUI action', async () => {
    fakeTransport();
    await expect(fetchNui('getCitizenId', null)).rejects.toThrow(/cannot call NUI action/);
  });

  it('routes the generic service action through the service facet', async () => {
    const f = fakeTransport();
    const p = fetchNui(GENERIC_SERVICE_ACTION, {
      service: 'marketplace',
      action: 'feed',
      data: { x: 1 }
    });
    const msg = f.sent[0] as Extract<ToShell, { kind: 'call' }>;
    expect(msg).toMatchObject({
      kind: 'call',
      facet: 'service',
      factoryArgs: ['marketplace'],
      member: 'call',
      args: ['feed', { x: 1 }]
    });
    f.replies.get(msg.id)!({ kind: 'reply', id: msg.id, ok: true, value: { rows: [] } });
    await expect(p).resolves.toEqual({ rows: [] });
  });

  it('honours defaultValue on failure', async () => {
    const f = fakeTransport();
    const p = fetchNui(
      GENERIC_SERVICE_ACTION,
      { service: 'marketplace', action: 'feed' },
      { defaultValue: { rows: [] } }
    );
    const msg = f.sent[0] as Extract<ToShell, { kind: 'call' }>;
    f.replies.get(msg.id)!({
      kind: 'reply',
      id: msg.id,
      ok: false,
      error: { name: 'Error', message: 'boom' }
    });
    await expect(p).resolves.toEqual({ rows: [] });
  });
});
