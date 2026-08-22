import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { onDestroy } from 'svelte';
import { fn, type AsTwin } from './_shared';
import { remoteCall } from '../remote';
import { clientTransport } from '../transport';
import type { AppEvent } from '../../../../shell/state/appEvents';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/appEvents').appEvents>>;

/** Implementation of the `useAppEvents` facet — see the inProcess twin for the usage contract. */
export function appEvents(appId: string): Twin {
  const factoryArgs = [appId];

  const subscribe = (member: 'on' | 'onAny', args: unknown[]): (() => void) => {
    const handler = args[args.length - 1] as (...a: unknown[]) => unknown;
    const refPromise = remoteCall<() => void>('appEvents', factoryArgs, member, ...args);
    // MICA-23: `handler` also still lives in this frame's own callback map until
    // dropped here, alongside releasing the server's own subscription handle.
    const off = () => {
      void refPromise.then((release) => release());
      clientTransport().releaseCallback(handler);
    };
    try {
      onDestroy(off);
    } catch {
      // Called outside a component. Deliberate — that is the module-scope case.
    }
    return off;
  };

  return {
    on: <T = Record<string, unknown>>(event: string, handler: (e: AppEvent<T>) => void) =>
      subscribe('on', [event, handler]),
    onAny: (handler: (e: AppEvent) => void) => subscribe('onAny', [handler]),
    clear: fn('appEvents', factoryArgs, 'clear')
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('appEvents', appEvents as unknown as Facets['appEvents']);
