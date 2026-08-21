import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fetchNuiModule from '../../nui/fetchNui';
import { renderApp } from '../testing';
import { AppPermissionError } from './protocol';
import { resetHostsForTest } from './current';
import UsesContacts from './__fixtures__/UsesContacts.svelte';
import Blabber from '../../apps/blabber/index.svelte';
import blabberManifest from '../../apps/blabber/manifest';

describe('host refusal', () => {
  beforeEach(() => {
    resetHostsForTest();
  });

  it('throws AppPermissionError for an app with no declared permissions', () => {
    let caught: unknown;
    try {
      renderApp(UsesContacts, { id: 'probe', permissions: [] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppPermissionError);
    const error = caught as AppPermissionError;
    expect(error.hookName).toBe('useContacts');
    expect(error.permission).toBe('contacts');
    expect(error.appId).toBe('probe');
  });

  it('renders when the permission is declared', () => {
    expect(() => renderApp(UsesContacts, { id: 'probe', permissions: ['contacts'] })).not.toThrow();
  });

  it('renders Blabber without throwing when given its declared permissions', () => {
    // Blabber's store-scope hooks (useAccounts et al.) run at module import time, before
    // `renderApp` below registers the host, so they resolve against the system host, not
    // this test's `blabber` one. This proves the component-init path renders cleanly with
    // Blabber's declared permissions — it does not exercise the store-scope declarations
    // themselves, which is why it cannot catch a bad permission on one of those hooks.
    vi.spyOn(fetchNuiModule, 'fetchNui').mockResolvedValue({ rows: [] } as any);

    expect(() =>
      renderApp(Blabber, { id: 'blabber', permissions: blabberManifest.permissions })
    ).not.toThrow();
  });
});
