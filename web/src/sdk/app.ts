/**
 * `@gphone/sdk/app` — the entry a **manifest** imports, and nothing else.
 *
 * ## Why this exists
 *
 * A manifest has to be loadable before the SDK is. `shell/state/registry.ts` globs every
 * manifest eagerly to build the launcher, and `sdk/host/useAppRegistry.ts` reads that
 * registry — so importing `@gphone/sdk` loads every app, and every app imports the barrel
 * back while it is still evaluating. Every binding comes out `undefined`, and the symptom
 * is `useService is not a function` on a line that plainly imports it.
 *
 * That one cycle is the source of every "not yet" in this codebase: `lazyBadge` deferring
 * badge composition, Notes building its store on first use, both `preload`s reaching for
 * `import('./store')`, and Blabber's migration stalling on eight module-scope SDK calls.
 * Four workarounds, one cause.
 *
 * The fix is to split the SDK by **when** it is needed rather than by what it is. This
 * module is a leaf: `defineApp` and `lazyBadge` between them import types, `./version`,
 * and nothing further. A manifest importing only this cannot close a loop, because there
 * is no edge to close it with.
 *
 * ## What goes where
 *
 * - **`@gphone/sdk/app`** — a manifest. `defineApp`, `lazyBadge`, and the types either
 *   needs.
 * - **`@gphone/sdk`** — everything else an app is built from: hooks, UI, stores. Imported
 *   by `index.svelte` and the app's own modules, which load when the app is opened, long
 *   after the barrel is up.
 *
 * A badge that needs a hook reaches for it **inside** the deferred factory, which is why
 * `lazyBadge` accepts an async one:
 *
 * ```ts
 * badgeStore: lazyBadge(async () => {
 *   const { useMail } = await import('@gphone/sdk');
 *   return useMail().unreadMailCount;
 * })
 * ```
 *
 * That is not ceremony. It is the difference between "this app's badge needs the SDK" and
 * "this app's *manifest file* needs the SDK", and only the second one is a cycle.
 */

export { defineApp } from './manifest';
export { lazyBadge } from './lazyBadge';

// Types stay on the main barrel. A manifest declares its shape through `defineApp`'s
// parameter, so it never names one — and re-exporting them here would be surface with no
// caller, which `pnpm deadcode` is right to refuse.
