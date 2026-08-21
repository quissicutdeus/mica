import { registerFacet } from '../../current';
import { onDestroy } from 'svelte';
import { fn } from './_shared';
import { remoteCall } from '../remote';
import type { AppEvent } from '../../../../shell/state/appEvents';

type Twin = ReturnType<typeof import('../../inProcess/facets/appEvents').appEvents>;

/** Implementation of the `useAppEvents` facet — see the inProcess twin for the usage contract. */
export function appEvents(appId: string): Twin {
  const factoryArgs = [appId];

  const subscribe = (member: 'on' | 'onAny', args: unknown[]): (() => void) => {
    const refPromise = remoteCall<() => void>('appEvents', factoryArgs, member, ...args);
    const off = () => void refPromise.then((release) => release());
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
