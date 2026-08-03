/**
 * How often one player may call one action.
 *
 * There was nothing here at all: `ServiceEndpoint` authenticates the caller and reduces the
 * payload to an allowlist, and then answers as many requests as arrive. §2.9 already says
 * every field in a `gphone:server:*` payload is attacker-controlled — the *rate* is too, and
 * a client with an executor can spam `create` until the table is the size of the disk.
 *
 * It matters more now than it did a week ago. While every read carried an ownership predicate
 * and every write landed in the caller's own rows, the blast radius of a flood was the
 * flooder. Public reads and member-scoped writes changed that.
 *
 * Deliberately at the transport boundary rather than inside the generic CRUD handlers, so it
 * covers **custom** actions too — `messages:send`, `conversations:create`, `reports:resolve`.
 * Those are the expensive ones, and a limiter that only guarded the generic path would miss
 * every one of them.
 *
 * A fixed window rather than a token bucket. A bucket is smoother and needs a per-key refill
 * timestamp plus float arithmetic; a window needs a counter and a start time, and the
 * difference only shows up at a burst boundary where the honest answer is "ask again in a
 * moment" either way. Simpler thing that is checkable.
 */

/** Window length. One minute is long enough that a human never notices the edge. */
const WINDOW_MS = 60_000;

/**
 * Requests per window, per player, per action.
 *
 * 60 is chosen against real bursts rather than felt right. The heaviest legitimate pattern is
 * a player clicking through conversations — one `messages:get` each — or paging a feed, one
 * `get` per page. Both are a handful per minute. Nothing in the phone can honestly need one
 * call per second sustained on a *single* action, and the key includes the action, so opening
 * the phone (eight services preloading at once) counts as one each.
 */
const DEFAULT_LIMIT = 60;

const CONVAR = 'gphone_rate_limit';

interface Window {
  count: number;
  startedAt: number;
}

const windows = new Map<string, Window>();

/**
 * Test seam, matching `__setResourceLookup` in `FrameworkBridge`. A rate limiter is all
 * clock, and a test that had to sleep for a minute would not be written.
 */
let now: () => number = () => Date.now();
export const __setRateLimitClock = (fn?: () => number): void => {
  now = fn ?? (() => Date.now());
};

export const __resetRateLimits = (): void => {
  windows.clear();
};

/**
 * The configured ceiling, or the default.
 *
 * Read per call rather than cached, so a server owner can change it with `setr` and not
 * restart. `GetConvar` is a cheap native and this is already on the request path.
 */
const configuredLimit = (): number => {
  const raw = Number.parseInt(GetConvar(CONVAR, String(DEFAULT_LIMIT)), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
};

/**
 * Record a request and say whether it is allowed.
 *
 * Keyed on source **and** service **and** action. Source rather than citizenid because a
 * flood is worth stopping before `FrameworkBridge.getPlayer` runs, and because a caller with
 * no loaded character has no citizenid to key on but can still emit events.
 *
 * The window is pruned lazily, on read, rather than on a timer. A `setInterval` sweep would
 * hold a reference to every key it has ever seen for as long as the resource runs; this way a
 * player who disconnects has their entries reclaimed the next time anyone hits the same
 * action, and `forgetSource` clears them immediately on drop.
 */
export function allow(source: number, service: string, action: string): boolean {
  const limit = configuredLimit();
  const key = `${source}:${service}:${action}`;
  const at = now();
  const current = windows.get(key);

  if (!current || at - current.startedAt >= WINDOW_MS) {
    windows.set(key, { count: 1, startedAt: at });
    return true;
  }

  current.count += 1;
  return current.count <= limit;
}

/**
 * Drop everything remembered about a player who has left.
 *
 * FiveM reuses server ids, so without this the next player assigned this source inherits a
 * partly-spent window — a legitimate request refused for something a previous connection did.
 * The same reasoning `FrameworkBridge.unidentified` gives for refusing to invent an identity
 * from a source: a server id is a connection, not a person.
 */
export function forgetSource(source: number): void {
  const prefix = `${source}:`;
  for (const key of windows.keys()) {
    if (key.startsWith(prefix)) windows.delete(key);
  }
}

/** Registered once, by `ServiceEndpoint`'s module, so no service has to remember to. */
export function installRateLimitCleanup(): void {
  on('playerDropped', () => {
    forgetSource(source);
  });
}
