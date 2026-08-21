import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render } from '@testing-library/svelte';
import { guarded } from './guard';
import { HOST_CONTEXT_KEY, type Host } from './protocol';
import { registerHost, resetHostsForTest } from './current';
import { createInProcessHost } from './inProcess/createInProcessHost';
import GuardProbe from './__fixtures__/GuardProbe.svelte';

function fakeHost(appId: string, permissions: readonly string[] = []): Host {
  return {
    appId,
    permissions: permissions as Host['permissions'],
    require: (needed) => {
      if (needed === null) return;
      const list = Array.isArray(needed) ? needed : [needed];
      for (const p of list) {
        if (!permissions.includes(p)) {
          throw new Error(`missing ${p}`);
        }
      }
    },
    facets: {}
  };
}

describe('guarded()', () => {
  beforeEach(() => {
    resetHostsForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inside a component, returns the host set via Svelte context and enforces its require()', () => {
    const host = fakeHost('contacts_app', []); // declares nothing
    let outcome: { host?: Host; error?: unknown } = {};

    render(GuardProbe, {
      props: {
        hookName: 'useContacts',
        onResult: (r) => {
          outcome = r;
        }
      },
      context: new Map([[HOST_CONTEXT_KEY, host]])
    });

    expect(outcome.host).toBeUndefined();
    expect(outcome.error).toBeDefined();
  });

  it('inside a component, returns the context host when it declares the permission', () => {
    const host = fakeHost('contacts_app', ['contacts']);
    let outcome: { host?: Host; error?: unknown } = {};

    render(GuardProbe, {
      props: {
        hookName: 'useContacts',
        onResult: (r) => {
          outcome = r;
        }
      },
      context: new Map([[HOST_CONTEXT_KEY, host]])
    });

    expect(outcome.host).toBe(host);
    expect(outcome.error).toBeUndefined();
  });

  it('outside a component, falls back to the registered host for the given appId', () => {
    const host = createInProcessHost('blabber', ['storage']);
    registerHost(host);

    const result = guarded('useStorage', 'blabber');
    expect(result).toBe(host);
  });

  it('outside a component with no appId, falls back to the system host and warns once per hook in dev', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = guarded('useStorage');
    const second = guarded('useStorage');

    expect(first).toBe(second);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
