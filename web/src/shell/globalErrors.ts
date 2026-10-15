// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shell's last-resort catcher for `window` `error` and `unhandledrejection`.
 *
 * `<svelte:boundary>` (`ErrorBoundary.svelte`) only sees a throw during render or inside an
 * effect. A throw in an event handler, a timer, or a promise nobody awaits goes straight to
 * the window, and in CEF that is nowhere anyone looks: FiveM's client log carries what the
 * page prints to the console, and an uncaught error is not something the page printed. This
 * prints it, with a `[micaOS]` prefix and the stack as text, so it reaches that log.
 *
 * What it deliberately does **not** do:
 *
 * - **Never `preventDefault`, never swallow.** The original still reaches devtools exactly
 *   as it would have, with its clickable stack; this is a second, text-only copy.
 * - **No NUI call, no net event.** `ErrorBoundary` and `AddOnFrame` report nowhere beyond
 *   `console.error`, so there is no existing path to route through, and a new one would be
 *   a registered event a modified client can reach (AGENTS.md §2.9).
 * - **Not for add-ons.** A `core: false` add-on runs in a sandboxed srcdoc iframe; its
 *   errors fire on the frame's own window, never this one, and `srcdoc.ts`/`bootAddOn`
 *   already forward them to `AddOnFrame` over `postMessage`.
 *
 * It is bounded, because a throw inside a per-frame loop fires sixty times a second and
 * printing each one would flood the console and stall CEF in the printing:
 *
 * - **Dedupe**: an error is identified by its kind, message and first stack frame, and each
 *   identity prints once per session. The browser still reports every occurrence on its
 *   own, so the repeats are not lost — only not copied. At most {@link SEEN_LIMIT}
 *   identities are remembered, oldest forgotten first, so an error whose message embeds a
 *   counter cannot grow the set without bound.
 * - **Rate cap**: at most {@link RATE_LIMIT} prints per {@link RATE_WINDOW_MS} window, for
 *   the case dedupe cannot catch — a loop whose message changes each time. Anything past
 *   that is counted, and one summary line says how many when the window closes.
 * - **A new site always gets through the cap.** An error whose site — its first stack
 *   frame, or its message when it has no stack — has never printed bypasses the rate cap,
 *   so a one-off real error during a storm from one loop is printed, not folded into the
 *   summary. That has its own bound, {@link NEW_SITE_LIMIT} per window, so a stream of
 *   genuinely distinct sites cannot flood either. Worst case is the two added together.
 */

/** Distinct prints allowed per window. Enough for a real cascade (one cause, a few knock-ons). */
export const RATE_LIMIT = 10;
/** The rate cap's window. Long enough that a 60 fps loop is clamped to 2 lines a second. */
export const RATE_WINDOW_MS = 5_000;
/** Distinct identities remembered for dedupe; past this the oldest is forgotten. */
export const SEEN_LIMIT = 200;
/**
 * Prints per window for errors from a site never printed before, which skip the rate cap.
 * Twice the cap: a real cascade can fail in more places than it repeats in any one, and
 * the two together still hold the worst case to 30 lines per window, 6 a second.
 */
export const NEW_SITE_LIMIT = 20;

/**
 * Where the live handle is kept, on the target itself rather than in module scope: Vite HMR
 * can re-evaluate this module, and a fresh module-scope flag would not know the previous
 * evaluation's listeners are still attached.
 */
const HANDLE = Symbol.for('mica.globalErrors');

type Uninstall = () => void;
type Holder = { [HANDLE]?: Uninstall };

interface Report {
  kind: 'error' | 'rejection';
  message: string;
  stack: string | null;
  /** `file:line:col` from an `ErrorEvent`, for a throw that carries no stack. */
  location: string | null;
}

/** `String()` on a hostile rejection reason can itself throw; never let the catcher throw. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unprintable value]';
  }
}

function fromErrorEvent(event: Event): Report {
  const e = event as ErrorEvent;
  const error: unknown = e.error;
  const stack = error instanceof Error && error.stack ? error.stack : null;
  const message =
    error instanceof Error ? error.message : e.message || safeString(error ?? 'Unknown error');
  const location = e.filename ? `${e.filename}:${e.lineno ?? 0}:${e.colno ?? 0}` : null;
  return { kind: 'error', message, stack, location };
}

function fromRejection(event: Event): Report {
  const reason: unknown = (event as PromiseRejectionEvent).reason;
  if (reason instanceof Error) {
    return {
      kind: 'rejection',
      message: reason.message,
      stack: reason.stack || null,
      location: null
    };
  }
  return { kind: 'rejection', message: safeString(reason), stack: null, location: null };
}

/** The first line of a V8 stack that names a frame — the message line is skipped. */
function firstFrame(stack: string | null): string {
  if (!stack) return '';
  for (const line of stack.split('\n')) {
    if (line.trimStart().startsWith('at ')) return line.trim();
  }
  return '';
}

/** Add `key` to a set held to {@link SEEN_LIMIT} entries, forgetting the oldest first. */
function remember(set: Set<string>, key: string): void {
  set.add(key);
  if (set.size > SEEN_LIMIT) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

/**
 * Attach the catcher to `target` (the window, in the app). Idempotent: a second call
 * replaces the first's listeners rather than adding to them, so nothing double-logs and an
 * HMR-updated copy of this module takes over. Returns the matching uninstall.
 */
export function installGlobalErrors(target: EventTarget = window): Uninstall {
  const holder = target as unknown as Holder;
  holder[HANDLE]?.();

  const seen = new Set<string>();
  const sites = new Set<string>();
  let windowStart = 0;
  let printed = 0;
  let newSitesPrinted = 0;
  let suppressed = 0;
  let summaryTimer: ReturnType<typeof setTimeout> | null = null;

  const flushSummary = () => {
    summaryTimer = null;
    if (suppressed > 0) {
      console.error(
        `[micaOS] ${suppressed} further uncaught error(s) not printed in the last ${RATE_WINDOW_MS / 1000}s: rate cap reached.`
      );
    }
    suppressed = 0;
  };

  const report = (r: Report) => {
    const frame = firstFrame(r.stack);
    const key = `${r.kind}\u0000${r.message}\u0000${frame}`;
    if (seen.has(key)) return;
    const site = `${r.kind}\u0000${frame || r.message}`;
    const newSite = !sites.has(site);

    const now = Date.now();
    if (now - windowStart >= RATE_WINDOW_MS) {
      windowStart = now;
      printed = 0;
      newSitesPrinted = 0;
    }
    const allowed = newSite ? newSitesPrinted < NEW_SITE_LIMIT : printed < RATE_LIMIT;
    if (!allowed) {
      // Not remembered as seen: once the window reopens, this one still gets its print.
      suppressed++;
      summaryTimer ??= setTimeout(flushSummary, windowStart + RATE_WINDOW_MS - now);
      return;
    }

    remember(seen, key);
    remember(sites, site);
    // A new site's print counts against the cap too, so a storm's first line is one of its
    // RATE_LIMIT rather than one more on top of them.
    printed++;
    if (newSite) newSitesPrinted++;

    const label = r.kind === 'error' ? 'Uncaught error' : 'Unhandled promise rejection';
    // The stack as text, not the Error object: CEF's console-to-log path stringifies its
    // arguments, and an Error stringifies to its message alone. V8's stack already opens
    // with the message, so it replaces it rather than following it.
    const detail = r.stack ?? (r.location ? `${r.message} (${r.location})` : r.message);
    console.error(`[micaOS] ${label}:`, detail);
  };

  const onError = (event: Event) => report(fromErrorEvent(event));
  const onRejection = (event: Event) => report(fromRejection(event));

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);

  const uninstall: Uninstall = () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
    if (summaryTimer !== null) clearTimeout(summaryTimer);
    summaryTimer = null;
    if (holder[HANDLE] === uninstall) delete holder[HANDLE];
  };
  holder[HANDLE] = uninstall;
  return uninstall;
}

/** Detach whatever {@link installGlobalErrors} attached to `target`, if anything. */
export function uninstallGlobalErrors(target: EventTarget = window): void {
  (target as unknown as Holder)[HANDLE]?.();
}
