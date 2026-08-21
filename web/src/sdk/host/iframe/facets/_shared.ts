import { remoteCall, remoteStore } from '../remote';

// MICA-16 step 4: the two building blocks every iframe facet twin is made of.

/** A member that is a function on the twin: `(...args) => Promise<result>`. */
export const fn =
  (facet: string, factoryArgs: readonly unknown[], member: string) =>
  (...args: unknown[]) =>
    remoteCall(facet, factoryArgs, member, ...args);

/** A member that is a store on the twin. */
export const store = <T>(
  facet: string,
  factoryArgs: readonly unknown[],
  member: string,
  initial: T
) => remoteStore<T>(facet, factoryArgs, member, initial);
