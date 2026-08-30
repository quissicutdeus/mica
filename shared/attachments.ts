/**
 * How many photos one message, post or listing may carry.
 *
 * **One number, because three composers and one server helper all have to mean the same
 * thing by it.** Marketplace declared it twice — once in `CreateListing.svelte` to stop the
 * picker offering a fifth photo, once in `Marketplace.ts` to `.slice()` the result — while
 * Messages and Blabber declared it nowhere and accepted any length at all. A cap the server
 * enforces and a composer does not is an error a player can reach by ordinary use; a cap a
 * composer enforces and the server does not is not a cap (MICA-154).
 *
 * In `shared/` rather than either side for the reason `richText.ts` is: the UI renders from
 * it and the server refuses from it, and two copies is two places for them to stop agreeing.
 */
export const MAX_ATTACHMENTS = 4;
