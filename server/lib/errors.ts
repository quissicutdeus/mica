// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Values a message key interpolates: `{name}` in the catalog, `params.name` here. */
export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * A refusal meant for the player, and the only kind of thrown error whose text reaches a
 * toast (`ServiceEndpoint`). Everything else is logged and answered generically.
 *
 * Since MICA-216 it also carries a **message key**, so the client can say it in the
 * player's language: the server does not know the locale, the client does. `message` stays
 * the English text and stays required — it is the fallback for a client whose catalog does
 * not know the key, and what a server log shows. The key names an entry in the `server`
 * namespace of the shell's catalog (`web/src/shell/locales/server.en.json`), and
 * `server/__tests__/serverMessages.test.ts` holds every key thrown here to that file.
 *
 * ```ts
 * throw new PlayerFacingError('Not a participant in this conversation.', {
 *   key: 'server.messages.notParticipant'
 * });
 * ```
 */
export class PlayerFacingError extends Error {
  readonly key?: string;
  readonly params?: MessageParams;

  constructor(message: string, options: { key?: string; params?: MessageParams } = {}) {
    super(message);
    this.name = 'PlayerFacingError';
    this.key = options.key;
    this.params = options.params;
  }
}

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Try again in a moment.';
export const GENERIC_ERROR_KEY = 'server.generic';
