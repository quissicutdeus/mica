import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import HostProvider from './HostProvider.svelte';
import { getContext } from 'svelte';
import { AppPermissionError, HOST_CONTEXT_KEY, type Host } from './host/protocol';
import { createInProcessHost } from './host/inProcess/createInProcessHost';
import { resetHostsForTest } from './host/current';
import ProvidedUsesContacts from './host/__fixtures__/ProvidedUsesContacts.svelte';

describe('HostProvider', () => {
  it('sets the Host under HOST_CONTEXT_KEY for its children', () => {
    const host: Host = createInProcessHost('blabber', ['contacts']);
    let seen: Host | undefined;

    const childSnippet = createRawSnippet(() => ({
      render() {
        seen = getContext<Host>(HOST_CONTEXT_KEY);
        return '<div>Test</div>';
      }
    }));

    render(HostProvider, {
      props: { host, children: childSnippet }
    });

    expect(seen).toBe(host);
  });

  // `setContext` inside `$effect.pre` is what makes refusal happen at component init; a
  // HostProvider refactor that breaks that would silently downgrade every app to the
  // system host — this test is the pin. It renders a real component (not a raw snippet,
  // which cannot mount one) through HostProvider itself, not through `renderApp`'s
  // `context:` map, so it exercises the actual `setContext` call HostProvider makes.
  it('makes a permission-gated hook refuse or render through its own setContext, not a test shortcut', () => {
    resetHostsForTest();

    expect(() =>
      render(ProvidedUsesContacts, {
        props: { host: createInProcessHost('probe', []) }
      })
    ).toThrow(AppPermissionError);

    let caught: unknown;
    try {
      render(ProvidedUsesContacts, {
        props: { host: createInProcessHost('probe', []) }
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as AppPermissionError).hookName).toBe('useContacts');

    expect(() =>
      render(ProvidedUsesContacts, {
        props: { host: createInProcessHost('probe', ['contacts']) }
      })
    ).not.toThrow();
  });
});
