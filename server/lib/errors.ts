// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An error whose message is meant for the player who caused it.
 *
 * `ServiceEndpoint` forwarded `error.message` for **every** throw, which made the class of an
 * error invisible: "You cannot follow yourself." and a driver error carrying the statement text
 * that failed left the server through the same line, and a `Repository` invariant carrying a
 * table name did too. The client shows whatever arrives as a toast, so the difference between
 * those was nothing but which one happened to be thrown.
 *
 * So a message reaches a player only if something says it should. Two things do, and the pair
 * is the whole allowlist:
 *
 * - **`PlayerFacingError`** — a handler decided this request is refusable and said why in a
 *   sentence written for the person who made it.
 * - **`SchemaError`** (`shared/schema.ts`) — a declaration refused the payload, naming the
 *   field and nothing about the database.
 *
 * Everything else is a bug or an outage: logged with its stack, where a server owner can read
 * it, and answered with one sentence that discloses nothing.
 *
 * ## What belongs in a message here
 *
 * The same rule `Repository.assertWritableValue` already followed and the reason it exists: no
 * table name, no column type, no `[Repository]` prefix, no SQL, no internal identifier. A
 * player reading "gphone_media.data exceeds 16777215 characters" learns the schema and cannot
 * act on any of it; "That photo is too large to store." is the same refusal, usefully.
 *
 * And nothing that answers a question the caller has not earned. `media:item` deliberately
 * gives a missing row and somebody else's row the same sentence, because distinguishing them
 * answers "does this id exist" for ids the caller does not own.
 */
export class PlayerFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayerFacingError';
  }
}

/**
 * What a caller is told when something failed that was not their doing.
 *
 * Deliberately one sentence with nothing in it. An unexpected failure is either a bug or an
 * outage, and both are the server owner's to read in the log — a player learns nothing useful
 * from a stack trace and an attacker learns quite a lot.
 */
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Try again in a moment.';
