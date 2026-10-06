// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. The iframe twins, because
 * this file stands where a sandboxed add-on stands — and then hands what that add-on sent to
 * the shell's own `IframeHostServer`, so both sides of the wall are the real ones.
 */
import './registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineAddonService } from '@mica/shared/addonService';
import { fakeTransport } from './__fixtures__/fakeTransport';
import { service } from './facets/service';
import type { ToFrame, ToShell } from './messages';
import { useService } from '../useService';
import { registerFacet, resetHostsForTest } from '../current';
import { createInProcessHost } from '../inProcess/createInProcessHost';
import { defineApp } from '../../manifest';
import { createIframeHostServer } from '../../../web/src/shell/addon/IframeHostServer';
import { resetGrantsForTest } from '../../../web/src/shell/state/addOnGrants';

/**
 * MICA-308. `useService(declaration)` is a second spelling of `useService(declaration.id)`,
 * not a second door, so the shell must not be able to tell them apart: the frame sends the
 * same message for both, and `serviceAllowed` answers both the same way. A declaration
 * naming somebody else's service is refused exactly as the string would be.
 */
const own = defineAddonService({ id: 'probe', actions: { list: { input: {} } } });
const foreign = defineAddonService({ id: 'contacts', actions: { list: { input: {} } } });

/** What the frame sends for one `call`, captured off the wire rather than assumed. */
const sentBy = (call: () => unknown): Extract<ToShell, { kind: 'call' }> => {
  // The iframe twin, every time: `shellAnswers` swaps the shell's stand-in into the same
  // registry, and a frame-side call made after it would never reach the wire.
  registerFacet('service', service);
  const wire = fakeTransport();
  void call();
  expect(wire.sent).toHaveLength(1);
  return wire.sent[0] as Extract<ToShell, { kind: 'call' }>;
};

/** A message minus its correlation id, which is a counter and differs call to call. */
const content = <M extends { id?: number }>({ id: _id, ...rest }: M) => rest;

/** The shell's answer to `message`, from an add-on whose app id is `probe`. */
const shellAnswers = async (message: ToShell): Promise<ToFrame> => {
  // The shell's own `service` facet, stood in: what is under test is whether the request
  // gets that far, not what the server would say.
  registerFacet('service', ((id: string) => ({
    id,
    call: () => Promise.resolve('ok')
  })) as never);
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
  await Promise.resolve();
  await Promise.resolve();
  expect(posted).toHaveLength(1);
  return posted[0];
};

beforeEach(() => {
  resetHostsForTest();
  resetGrantsForTest();
});

describe('useService(declaration) inside a sandboxed add-on', () => {
  it('sends the very message the string form sends', () => {
    // Captured before either reaches the shell, so the comparison is of what crosses the
    // wall and nothing else.
    expect(content(sentBy(() => useService(own).call('list')))).toEqual(
      content(sentBy(() => useService('probe').call('list')))
    );
    expect(sentBy(() => useService(own).call('list'))).toMatchObject({
      facet: 'service',
      factoryArgs: ['probe'],
      member: 'call',
      args: ['list']
    });
  });

  it("is answered for the add-on's own service", async () => {
    expect(await shellAnswers(sentBy(() => useService(own).call('list')))).toMatchObject({
      ok: true
    });
  });

  it("is refused for another service's declaration, exactly as the string is", async () => {
    const byDeclaration = await shellAnswers(sentBy(() => useService(foreign).call('list')));
    const byString = await shellAnswers(sentBy(() => useService('contacts').call('list')));

    expect(byDeclaration).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("may only use its own service, not 'contacts'") }
    });
    expect(content(byDeclaration as { id?: number })).toEqual(content(byString as { id?: number }));
  });
});
