import { registerFacet } from '../../current';
import { onDestroy } from 'svelte';
import { fn, store } from './_shared';
import { remoteCall } from '../remote';
import { clientTransport } from '../transport';

type Twin = ReturnType<typeof import('../../inProcess/facets/keybinds').keybinds>;

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
    /**
     * Async here, unlike the inProcess twin's synchronous setter — no add-on calls this;
     * Settings, which does, is a core app and runs in-process.
     */
    setBinding: fn('keybinds', [], 'setBinding'),
    resetBindings: fn('keybinds', [], 'resetBindings'),
    findConflict: fn('keybinds', [], 'findConflict')
  } as unknown as Twin;
}

registerFacet('keybinds', keybinds);
