/**
 * Every service name the server answers to.
 *
 * A service is a named group of server actions — the `<service>` segment of
 * `gphone:<side>:<service>:<action>`. Most are backed by a table and declared with
 * `defineService`, but not all: `phone` is pure signalling, and `shell` only ever pushes
 * outward.
 *
 * This exists so nothing has to keep a list of the ones that are different. It used to:
 * `eventNames.test.ts` hard-coded `NON_APP_SEGMENTS = ['shell', 'admin']` plus a second
 * exception for `bank` and `phone`, because the vocabulary called everything an "app" and
 * four of them plainly were not. A name that needs a written-down list of things it does
 * not apply to is the wrong name.
 *
 * Now a service declares itself where it is defined, and the test reads the registry.
 */
const services = new Set<string>();

/** Declare a service. Returns the id so it can be used inline. */
export const registerService = (id: string): string => {
  services.add(id);
  return id;
};

/** Every declared service name, table-backed or not. */
export const knownServices = (): string[] => [...services];
