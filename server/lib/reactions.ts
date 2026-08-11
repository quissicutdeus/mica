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
