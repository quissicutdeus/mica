// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The message to show a player for something that was thrown.
 *
 * Five places wrote `e?.message || 'something went wrong'` by hand, typing the catch as
 * `any` to do it, and two of them wrote `e.message` — which throws a second time inside
 * the catch if what arrived was a string or null. `catch` gives you `unknown` because
 * anything at all can be thrown, and that is worth honoring in the one place that has
 * to deal with it.
 */
export function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;

  // A plain object with a message — what a rejected `fetchNui` reply or a framework
  // error tends to be.
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }

  return fallback;
}

/**
 * The server said no, and said which no (MICA-310).
 *
 * A refusal the server meant for the player arrives as `{ error, key, params? }`
 * (`server/lib/ServiceEndpoint.ts`): `key` names an entry in the shell's `server` catalog and
 * `error` is the English beside it. The phone's `fetchNui` turns that reply into this, with
 * `message` already in the player's language — so anything that shows the message shows
 * exactly what it did before — and the **key kept**, so code can tell one refusal from every
 * other failure without comparing text a translator is free to reword.
 *
 * Only a reply that named a key becomes one. A timeout, a malformed request, a missing server
 * half, an add-on handler's own `addonError(...)` text (keyless by design — it cannot speak in
 * micaOS's catalog) and every throw on this side stay a plain `Error`, because there is no
 * key to keep. The generic "something went wrong" is keyed (`server.generic`), so it _is_ one;
 * name the key you mean rather than asking whether there was any.
 *
 * A sandboxed add-on gets the same class: the shell sends the key across `postMessage` beside
 * the message and the frame rebuilds it (`host/iframe/remote.ts`). Constructing one yourself
 * convinces nothing but your own code — the shell never accepts one from a frame.
 */
export class ServiceRefusal extends Error {
  constructor(
    /** The catalog key the server named, `server.jobs.lineUnavailable` say. Never translated. */
    public readonly key: string,
    message: string
  ) {
    super(message);
    this.name = 'ServiceRefusal';
  }
}

/**
 * Whether `error` is the server refusing, and — given `key` — refusing with that key.
 *
 * ```ts
 * try {
 *   await useService('journal').call('create', { title });
 * } catch (error) {
 *   if (isRefusal(error, 'server.rateLimited')) return showSlowDown();
 *   throw error;
 * }
 * ```
 *
 * Matches on the key the server sent, never on the message, so a reworded or translated
 * catalog changes nothing here. A plain `Error` — whatever its message, and whatever `key`
 * property somebody hung on it — is not a refusal.
 *
 * The keys are the shell's `server` catalog's (`web/src/shell/locales/server.en.json`). What
 * an add-on's own service can answer with is a short list — `server.rateLimited`,
 * `server.notAuthenticated`, `server.endpoint.appDisabled` (the owner switched the app off)
 * and `server.generic` — because its handlers' refusals carry no key.
 */
export function isRefusal(error: unknown, key?: string): error is ServiceRefusal {
  return error instanceof ServiceRefusal && (key === undefined || error.key === key);
}
