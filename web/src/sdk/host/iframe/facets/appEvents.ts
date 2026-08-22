import { registerFacet } from '../../current';
import { onDestroy } from 'svelte';
import { fn } from './_shared';
import { remoteCall } from '../remote';
import { clientTransport } from '../transport';
import type { AppEvent } from '../../../../shell/state/appEvents';

type Twin = ReturnType<typeof import('../../inProcess/facets/appEvents').appEvents>;

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
  } as unknown as Twin;
}

registerFacet('appEvents', appEvents);
