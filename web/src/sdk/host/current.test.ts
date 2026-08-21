import { describe, it, expect, beforeEach } from 'vitest';
import { registerHost, hostFor, setSystemHost, systemHost, resetHostsForTest } from './current';
import type { Host } from './protocol';

function fakeHost(appId: string): Host {
  return {
    appId,
    permissions: [],
    require: () => {},
    facets: {}
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
