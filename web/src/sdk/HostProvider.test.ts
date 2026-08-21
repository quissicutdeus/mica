import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import HostProvider from './HostProvider.svelte';
import { getContext } from 'svelte';
import { HOST_CONTEXT_KEY, type Host } from './host/protocol';
import { createInProcessHost } from './host/inProcess/createInProcessHost';

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
});
