import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerHost,
  hostFor,
  setSystemHost,
  systemHost,
  resetHostsForTest,
  registerFacet,
  facets
} from './current';
import type { Host } from './protocol';

function fakeHost(appId: string): Host {
  return {
    appId,
    permissions: [],
    require: () => {},
    facets: {} as Host['facets']
  };
}

describe('host registry', () => {
  beforeEach(() => {
    resetHostsForTest();
  });

  it('registers and looks a host up by appId', () => {
    const host = fakeHost('blabber');
    registerHost(host);
    expect(hostFor('blabber')).toBe(host);
  });

  it('returns undefined for an unregistered appId', () => {
    expect(hostFor('nope')).toBeUndefined();
  });

  it('a later registration replaces an earlier one for the same appId', () => {
    const first = fakeHost('blabber');
    const second = fakeHost('blabber');
    registerHost(first);
    registerHost(second);
    expect(hostFor('blabber')).toBe(second);
  });

  it('systemHost() throws before setSystemHost is called', () => {
    expect(() => systemHost()).toThrow();
  });

  it('systemHost() returns what setSystemHost set', () => {
    const host = fakeHost('system');
    setSystemHost(host);
    expect(systemHost()).toBe(host);
  });
});

describe('facet registry', () => {
  it('registers a facet and reads it back through the proxy', () => {
    // `registerFacet` writes into the module-level `facetRecord` that every consumer of
    // `current.ts` shares — this file gets away with mutating it directly only because it
    // imports no hook of its own, so nothing else in this file depends on `clock` staying
    // unregistered (or registered as anything in particular).
    const fn = () => 'ok';
    registerFacet('clock', fn as never);
    expect(facets.clock).toBe(fn);
  });

  it('throws naming the facet when it was never registered', () => {
    expect(() => (facets as never as Record<string, unknown>).neverRegisteredFacet).toThrow(
      /neverRegisteredFacet/
    );
  });

  it('does not throw for symbol access or `then` — only for an unregistered string key', () => {
    // `String(facets)`, `console.log(facets)`, `expect(...).toEqual(...)` and an `await`
    // near the object all probe `Symbol.toStringTag` / `Symbol.toPrimitive` / `'then'`
    // before ever naming a real facet. None of those is a facet name, and none should throw.
    expect(() => String(facets)).not.toThrow();
    expect(
      () => (facets as unknown as { [Symbol.toStringTag]?: string })[Symbol.toStringTag]
    ).not.toThrow();
    expect((facets as unknown as { then?: unknown }).then).toBeUndefined();
    // A real unregistered string key still throws, naming itself.
    expect(() => (facets as never as Record<string, unknown>).stillUnregistered).toThrow(
      /stillUnregistered/
    );
  });
});
