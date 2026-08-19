import { describe, it, expect, beforeEach } from 'vitest';
import {
  setTrustedRemoteAppHosts,
  getTrustedRemoteAppHosts,
  isTrustedRemoteUrl,
  sha256Hex,
  matchesHash
} from './remoteAppSecurity';

describe('remote-app host allowlist', () => {
  beforeEach(() => setTrustedRemoteAppHosts([]));

  it('trusts nothing until an operator configures a host', () => {
    expect(getTrustedRemoteAppHosts()).toEqual([]);
    expect(isTrustedRemoteUrl('https://store.example.com/apps/foo.js')).toBe(false);
  });

  it('trusts an https URL whose host is on the allowlist', () => {
    setTrustedRemoteAppHosts(['store.example.com']);
    expect(isTrustedRemoteUrl('https://store.example.com/apps/foo.js')).toBe(true);
  });

  it('is case-insensitive on the hostname', () => {
    setTrustedRemoteAppHosts(['Store.Example.com']);
    expect(isTrustedRemoteUrl('https://store.example.com/apps/foo.js')).toBe(true);
  });

  it('rejects a host not on the allowlist', () => {
    setTrustedRemoteAppHosts(['store.example.com']);
    expect(isTrustedRemoteUrl('https://evil.example.com/apps/foo.js')).toBe(false);
  });

  it('rejects http even for an allowlisted host', () => {
    setTrustedRemoteAppHosts(['store.example.com']);
    expect(isTrustedRemoteUrl('http://store.example.com/apps/foo.js')).toBe(false);
  });

  it('rejects a malformed URL rather than throwing', () => {
    setTrustedRemoteAppHosts(['store.example.com']);
    expect(isTrustedRemoteUrl('not a url')).toBe(false);
  });

  it('rejects an empty or non-string URL', () => {
    expect(isTrustedRemoteUrl('')).toBe(false);
    expect(isTrustedRemoteUrl(undefined as unknown as string)).toBe(false);
  });

  it('always trusts a data: URL — there is no remote host to check', () => {
    expect(isTrustedRemoteUrl('data:text/javascript;charset=utf-8,export const x = 1;')).toBe(
      true
    );
  });
});

describe('bundle hash verification', () => {
  it('hashes text to the known SHA-256 hex digest', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('matches when the text hashes to the expected digest', async () => {
    const hash = await sha256Hex('hello gPhone');
    expect(await matchesHash('hello gPhone', hash)).toBe(true);
  });

  it('does not match when the text has been tampered with', async () => {
    const hash = await sha256Hex('hello gPhone');
    expect(await matchesHash('hello gphone (tampered)', hash)).toBe(false);
  });

  it('is case-insensitive comparing the expected digest', async () => {
    const hash = await sha256Hex('abc');
    expect(await matchesHash('abc', hash.toUpperCase())).toBe(true);
  });

  it('refuses an empty expected hash rather than treating it as a wildcard', async () => {
    expect(await matchesHash('anything', '')).toBe(false);
  });
});
