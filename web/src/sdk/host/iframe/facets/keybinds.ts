import { registerFacet } from '../../current';
import { onDestroy } from 'svelte';
import { fn, store, type AsTwin } from './_shared';
import { remoteCall } from '../remote';
import { clientTransport } from '../transport';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/keybinds').keybinds>>;

/** Implementation of the `useKeybinds` facet — see the inProcess twin for the usage contract. */
export function keybinds(): Twin {
  return {
    onKeybind: (actionId: string, handler: () => void, appId?: string) => {
      const releasePromise = remoteCall<() => void>(
        'keybinds',
        [],
        'onKeybind',
        actionId,
        handler,
        appId
      );
      // MICA-23: releasing the server's handle (`off()`) is only half of it — `handler`
      // is still sitting in this frame's own callback map (`registerCallback`, called
      // inside `remoteCall`'s `encodeArgs`) until this drops it too.
      const release = () => {
        void releasePromise.then((off) => off());
        clientTransport().releaseCallback(handler);
      };
      try {
        onDestroy(release);
      } catch {
        // Called outside a component lifecycle; the caller owns cleanup.
      }
      return release;
    },
    bindings: store('keybinds', [], 'bindings', {}),
    groups: store('keybinds', [], 'groups', []),
    // Async here, unlike the inProcess twin's synchronous return; findConflict's sync
    // return value (not void) means TS won't quietly accept the Promise-returning twin
    // without saying so.
    findConflict: fn('keybinds', [], 'findConflict') as unknown as Twin['findConflict']
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('keybinds', keybinds);
