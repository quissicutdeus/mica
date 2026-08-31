// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { useService, usePersisted, useAppEvents } from '@gphone/sdk';
import { useNuiBridge } from '@gphone/sdk/core';

/**
 * The SDK barrel must be importable from a module that runs early.
 *
 * It was not, and the cycle was this: `@gphone/sdk` re-exports `useAppRegistry`, which
 * imports `shell/state/registry.ts`, which globs every `apps/*​/manifest.ts` **eagerly** —
 * and every manifest imported the barrel back while it was still evaluating. Every binding
 * came out `undefined`, and the symptom was `useService is not a function` on a line that
 * plainly imports it.
 *
 * It is the single cause behind four separate workarounds: `lazyBadge` deferring badge
 * composition, Notes building its store on first use, both `preload`s reaching for
 * `import('./store')`, and Blabber's migration stalling on eight module-scope SDK calls.
 *
 * `@gphone/sdk/app` fixed it by being a leaf a manifest can import without pulling
 * anything. **These calls are at module scope on purpose** — that is the exact position
 * that used to fail.
 *
 * Be clear about what this does and does not prove. Pointing one manifest back at the full
 * barrel does **not** make it fail: under Vitest the barrel is already resolved by the time
 * the glob runs, so this asserts the graph is sound today rather than guarding against a
 * regression. The guard is `manifests import the leaf, never the barrel` in
 * `boundary.test.ts`, which is deterministic because it reads the source.
 */
const service = useService('probe');
const preference = usePersisted('probe', 'k', 0);
const events = useAppEvents('probe');
const bridge = useNuiBridge();

describe('SDK barrel initialisation', () => {
  it('resolves every binding when called at module scope', () => {
    expect(typeof service.call).toBe('function');
    expect(typeof preference.subscribe).toBe('function');
    expect(typeof events.on).toBe('function');
    expect(typeof bridge.fetchNui).toBe('function');
  });
});
