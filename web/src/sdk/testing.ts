import { vi } from 'vitest';
import { render } from '@testing-library/svelte';
import type { Component } from 'svelte';
import { currentApp } from '../shell/state/navigation';

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
export function renderApp<Props extends Record<string, unknown>>(
  App: Component<Props>,
  { id, props }: RenderAppOptions<Props>
) {
  // Before `render`, not after: the component subscribes on init, and the transition it
  // is watching for has to have happened by then.
  currentApp.set({ id: id.toLowerCase(), props: {} });

  const onback = vi.fn();

  // The casts are the price of injecting `onback` into a component whose prop type is
  // still a generic here. Apps disagree on whether `onback` is optional — six declare a
  // bare `$props()` and the seven that type it are split — and there is no `AppProps` to
  // appeal to, since `Shell.svelte` renders every app as `any`. The public signature
  // above stays honest: callers get their own component's props checked.
  const result = render(App as unknown as Component<Record<string, unknown>>, {
    props: { onback, ...props } as Record<string, unknown>
  });

  // Returned so a test can assert the app leaves when asked, which is the one prop every
  // app takes and the easiest to wire backwards.
  return { ...result, onback };
}
