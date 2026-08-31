import { describe, it, expect } from 'vitest';
import { capabilitiesSatisfy, manifestVisible, type VisibilityFacts } from './appVisibility';
import type { AppManifest } from '../sdk/manifest';

const app = (extra: Partial<AppManifest> = {}): AppManifest =>
  ({
    id: 'widget',
    name: 'Widget',
    core: true,
    tile: { bg: 'bg-sky-500' },
    color: 'bg-sky-500',
    permissions: [],
    ...extra
  }) as AppManifest;

const facts = (isAdmin: boolean, money: boolean): VisibilityFacts => ({
  isAdmin,
  capabilities: { money }
});

describe('manifestVisible', () => {
  it('shows an app that asks for nothing, whatever the phone can do', () => {
    expect(manifestVisible(app(), facts(false, false))).toBe(true);
  });

  it('hides an app whose id no longer resolves to a manifest', () => {
    // A home-grid cell, a folder entry and a dock slot all hold ids that outlive the app
    // they name. Answering here is what keeps four callers from each needing a null check.
    expect(manifestVisible(undefined, facts(true, true))).toBe(false);
    expect(manifestVisible(null, facts(true, true))).toBe(false);
  });

  it('hides an admin app from everyone else', () => {
    const admin = app({ requiresAdmin: true });

    expect(manifestVisible(admin, facts(false, true))).toBe(false);
    expect(manifestVisible(admin, facts(true, true))).toBe(true);
  });

  it('hides an app whose required capability this server does not have', () => {
    const bank = app({ requires: ['money'] });

    expect(manifestVisible(bank, facts(true, false))).toBe(false);
    expect(manifestVisible(bank, facts(true, true))).toBe(true);
  });

  it('needs both axes satisfied, not either', () => {
    const both = app({ requiresAdmin: true, requires: ['money'] });

    expect(manifestVisible(both, facts(true, false))).toBe(false);
    expect(manifestVisible(both, facts(false, true))).toBe(false);
    expect(manifestVisible(both, facts(true, true))).toBe(true);
  });

  it('treats an unanswered capability the same as a denied one', () => {
    // The store starts empty in game and fills in when the server replies. Until then an
    // app that needs something is absent, which is the direction that fails loudly rather
    // than shipping an ungated launcher whenever the endpoint is missing.
    expect(manifestVisible(app({ requires: ['money'] }), { isAdmin: true, capabilities: {} })).toBe(
      false
    );
  });
});

describe('capabilitiesSatisfy', () => {
  it('is satisfied by an empty requirement list', () => {
    expect(capabilitiesSatisfy({}, undefined)).toBe(true);
    expect(capabilitiesSatisfy({}, [])).toBe(true);
  });

  it('needs every name, not any', () => {
    expect(capabilitiesSatisfy({ money: true }, ['money'])).toBe(true);
    expect(capabilitiesSatisfy({ money: false }, ['money'])).toBe(false);
  });
});
