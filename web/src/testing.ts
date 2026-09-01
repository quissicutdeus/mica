// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MICA-172 moved this file out of `sdk/` and into `web/src/`, and `@gphone/sdk/testing` is
 * now a **web-side alias** rather than a package export. It needs `createInProcessHost`, the
 * in-process facet set and `shell/state/navigation` — it renders an app the way the shell
 * does, which is a phone concern, not something the published SDK can carry across a package
 * boundary. Its own docblock below already said it is not exported from `@gphone/sdk`; the
 * specifier is unchanged and all four consumers are `web/` app tests.
 *
 * MICA-176. `@gphone/sdk/testing` is an entry point like `src/main.ts` and `bootAddOn`,
 * so it supplies a facet set the same way: a test that renders an app is standing in for
 * the shell, and gets the in-process facets. Before this ticket every hook pulled its own
 * facet onto the graph, so a test never had to say which side it was on.
 */
import './host/registerFacets';
import { vi } from 'vitest';
import { render } from '@testing-library/svelte';
import type { Component } from 'svelte';
import { currentApp } from './shell/state/navigation';
import {
  ALL_PERMISSIONS,
  type AppComponent,
  type AppPermission,
  type AppProps
} from '../../sdk/manifest';
import { HOST_CONTEXT_KEY } from '../../sdk/host/protocol';
import { createInProcessHost } from '../../sdk/host/inProcess/createInProcessHost';
import { registerHost } from '../../sdk/host/current';

/**
 * Test-only SDK surface. **Not exported from `@gphone/sdk`** — importing this pulls in
 * `@testing-library/svelte` and `vitest`, neither of which belongs in a phone that
 * ships. Import it as `@gphone/sdk/testing`, which is aliased for exactly this.
 *
 * Only 3 of 12 apps have any unit test, and the setup ritual is a large part of why.
 */

export interface RenderAppOptions<Props> {
  /**
   * The app's registry id — `bank`, `store`.
   *
   * Required, and the reason this helper exists. An app loads with `onAppForeground`,
   * which fires on the transition to *being the foreground app* — so rendering the
   * component in isolation is not enough, and an app tested that way silently never
   * fetches. Nothing about `render()` hints at that.
   */
  id: string;
  /** Props for the component. `onback` is supplied unless you override it. */
  props?: Partial<Props>;
  /**
   * What the app's `Host` declares. Defaults to `ALL_PERMISSIONS` — every existing test
   * that doesn't pass this keeps working unchanged. `permissions: []` is how a test sees
   * a refusal: it renders the app with a host that grants nothing, so any hook it calls
   * without the matching permission throws `AppPermissionError`.
   */
  permissions?: readonly AppPermission[];
}

/**
 * Render an app the way the shell does.
 *
 * ```ts
 * const { findByText, onback } = renderApp(Bank, { id: 'bank' });
 * expect(await findByText('No transactions')).toBeTruthy();
 * ```
 *
 * Two things it deliberately does not do, because neither can be done from here:
 *
 * - **Mock `fetchNui`.** `vi.mock` is hoisted to the top of the *test file*; a call
 *   inside a helper runs too late for the component's imports.
 * - **Reset your app's stores.** They are module-scoped, so they survive between tests
 *   in the same file — the second test inherits the first one's completed fetch and
 *   never sees the loading frame. Which stores those are is app-specific.
 */
export function renderApp<Props extends AppProps>(
  App: Component<Props>,
  { id, props, permissions }: RenderAppOptions<Props>
) {
  // Before `render`, not after: the component subscribes on init, and the transition it
  // is watching for has to have happened by then.
  const appId = id.toLowerCase();
  currentApp.set({ id: appId, props: {} });

  const host = createInProcessHost(appId, permissions ?? ALL_PERMISSIONS);
  registerHost(host);

  const onback = vi.fn();

  // One cast, and only because `Props` is still open here: the compiler cannot know that
  // `{ onback, ...props }` covers whatever an individual app added on top of `AppProps`.
  // The bound above is what carries the guarantee — a component that does not accept
  // `onback` is no longer something this function will take.
  const result = render(App as AppComponent, {
    props: { onback, ...props },
    context: new Map([[HOST_CONTEXT_KEY, host]])
  });

  // Returned so a test can assert the app leaves when asked, which is the one prop every
  // app takes and the easiest to wire backwards.
  return { ...result, onback };
}
