import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import AppCapabilityProvider from './AppCapabilityProvider.svelte';
import { useContacts } from './host/useContacts';
import { useCamera } from './host/useCamera';
import { useMedia } from './host/useMedia';
import { useLocation } from './host/useLocation';
import { usePhoneNotification } from './host/usePhoneNotification';
import { useStorage } from './host/useStorage';
import { assertCapability, checkCapability } from './capability';
import { defineApp } from './manifest';
import { createRawSnippet } from 'svelte';

describe('App capability disclosure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows system/shell execution outside an app context', () => {
    const res = checkCapability('contacts');
    expect(res.allowed).toBe(true);
    expect(res.appId).toBe('system');
    expect(() => assertCapability('contacts', 'testHook')).not.toThrow();
  });

  it('permits hook usage when manifest declares the permission', () => {
    let contactsRes: ReturnType<typeof useContacts> | undefined;
    let cameraRes: ReturnType<typeof useCamera> | undefined;

    const manifest = defineApp({
      id: 'test_app',
      name: 'Test App',
      color: 'bg-blue-500',
      icon: null,
      core: true,
      permissions: ['contacts', 'camera']
    });

    const childSnippet = createRawSnippet(() => ({
      render() {
        contactsRes = useContacts();
        cameraRes = useCamera();
        return '<div>Test</div>';
      }
    }));

    render(AppCapabilityProvider, {
      props: {
        appId: 'test_app',
        manifest,
        children: childSnippet
      }
    });

    expect(contactsRes).toBeDefined();
    expect(cameraRes).toBeDefined();
  });

  /**
   * `permissions` is a Store disclosure, not access control (`AGENTS.md` §7) — every app
   * shares the shell's own JS context, so a hook calling `assertCapability` can only warn,
   * never refuse. A throw here would crash a Store-installed add-on the moment it under-
   * declares a permission, which `web/src/sdk/permissions.test.ts` cannot catch for a remote
   * manifest the way it can for a first-party one.
   */
  it('does not throw when an app calls a hook without declaring the permission, but warns in dev', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manifest = defineApp({
      id: 'unauthorized_app',
      name: 'Unauthorized App',
      color: 'bg-red-500',
      icon: null,
      core: true,
      permissions: [] // Declares NO permissions
    });

    let contactsRes: ReturnType<typeof useContacts> | undefined;
    const childSnippet = createRawSnippet(() => ({
      render() {
        contactsRes = useContacts();
        return '<div>Test</div>';
      }
    }));

    render(AppCapabilityProvider, {
      props: {
        appId: 'unauthorized_app',
        manifest,
        children: childSnippet
      }
    });

    expect(contactsRes).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("App 'unauthorized_app' called 'useContacts'")
    );
  });

  it('never throws across any protected SDK hook, regardless of declared permissions', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const hooksToTest = [
      { hook: () => useCamera(), perm: 'camera' },
      { hook: () => useMedia(), perm: 'media' },
      { hook: () => useLocation(), perm: 'location' },
      { hook: () => usePhoneNotification(), perm: 'notifications' },
      { hook: () => useStorage('test'), perm: 'storage' }
    ] as const;

    for (const item of hooksToTest) {
      const manifest = defineApp({
        id: 'restricted_app',
        name: 'Restricted App',
        color: 'bg-gray-500',
        icon: null,
        core: true,
        permissions: []
      });

      let result: unknown;
      const snippet = createRawSnippet(() => ({
        render() {
          result = item.hook();
          return '<div>Test</div>';
        }
      }));

      expect(() =>
        render(AppCapabilityProvider, {
          props: {
            appId: 'restricted_app',
            manifest,
            children: snippet
          }
        })
      ).not.toThrow();
      expect(result).toBeDefined();
    }
  });
});
