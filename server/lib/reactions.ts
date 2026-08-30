/**
 * Tables a reaction may target, and the same allowlist reasoning as `moderation.ts`'s
 * `REPORTABLE`.
 *
 * `target_table` arrives in a NUI payload and is interpolated into SQL as a *value* bound
 * through a placeholder, not as an identifier — so this is not the injection guard
 * `REPORTABLE` is. It exists anyway because an unchecked `target_table` would let a client
 * invent a namespace and pollute reaction counts/queries for a table it has no business
 * reacting to, and because it is what makes "a table opts in to reactions" a declaration
 * rather than a hardcoded list naming an add-on's tables from core.
 */
export interface ReactableDefinition {
  label: string;
}

const reactable = new Map<string, ReactableDefinition>();

/**
 * Declare a table reactable. Called from `defineService`; not something to call by hand.
 *
 * Registration happens at import time, before any reaction can be handled — the same
 * ordering guarantee `registerReportable` relies on.
 */
export const registerReactable = (table: string, definition: ReactableDefinition): void => {
  reactable.set(table, definition);
};

export type ReactableTable = string;

export const isReactableTable = (table: unknown): table is ReactableTable =>
  typeof table === 'string' && reactable.has(table);

/**
 * 1–16 UTF-16 code units: a single emoji up to a multi-codepoint ZWJ/skin-tone sequence.
 *
 * Shared rather than duplicated per reaction path (`Accounts.ts`'s `react`/`unreact`, and
 * `Messages.ts`'s MICA-143 equivalent for native Messages) — the same validation is the
 * same rule regardless of which table's reactions are being written, and a second copy is
 * a second place for the two to quietly disagree about what a "single emoji" is.
 */
export const isPlausibleEmoji = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 16;
