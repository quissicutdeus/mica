/**
 * The message to show a player for something that was thrown.
 *
 * Five places wrote `e?.message || 'something went wrong'` by hand, typing the catch as
 * `any` to do it, and two of them wrote `e.message` — which throws a second time inside
 * the catch if what arrived was a string or null. `catch` gives you `unknown` because
 * anything at all can be thrown, and that is worth honouring in the one place that has
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
