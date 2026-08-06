import type { Readable, Unsubscriber } from 'svelte/store';

/**
 * A launcher badge count, composed the first time something reads it.
 *
 * `badgeStore` is read when an app is registered, which is the earliest moment in the
 * phone's life — earlier than any component, and earlier than the SDK barrel has finished
 * evaluating. So a manifest that calls a hook at module scope to build its count crashes
 * with `useX is not a function`: `shell/state/registry.ts` globs every manifest, and a
 * manifest importing `@gphone/sdk` closes a cycle back onto a module that is still
 * initializing.
 *
 * This defers the composition to the first `subscribe`, by which point every module is
 * up. The launcher subscribes when it paints, which is exactly when the number first
 * matters.
 *
 * ```ts
 * badgeStore: lazyBadge(() => {
 *   const { unreadCount } = useNotifications('my_app');
 *   return unreadCount;
 * })
 * ```
 *
 * The alternative was for the SDK to export each app's finished badge store — which is
 * how this started, with a `blabberTotalUnread` sitting in `sdk/utils.ts`. That made the
 * contract every app builds against hold a hardcoded reference to one app's service, so
 * an add-on the SDK has never heard of could not produce a badge at all. What a badge
 * counts is the app's business; when it may be computed is the platform's.
 */
export function lazyBadge(compose: () => Readable<number>): Readable<number> {
  let composed: Readable<number> | null = null;

  return {
    subscribe(run, invalidate?): Unsubscriber {
      // Composed once and reused, so several subscribers share one derivation rather than
      // rebuilding it — and so the underlying stores are subscribed once.
      composed ??= compose();
      return composed.subscribe(run, invalidate);
    }
  };
}
