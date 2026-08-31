/**
 * Pure helpers apps are allowed to use.
 *
 * Same reasoning as `components.ts`: an add-on installed from the Store resolves
 * `@gphone/sdk` and nothing else, so a helper reachable only at `../../utils/` does not
 * exist for it. Fifteen imports across the app modules were doing exactly that.
 *
 * Only things that are genuinely platform surface. App-specific helpers belong in the
 * app — `hashStringToCardNumber` was a `utils/` file used by nothing but Bank, and now
 * lives there.
 *
 * Every implementation below is in `sdk/lib/`, never `lib/phone/`, and that is checked
 * rather than observed: `lib/ownership.test.ts` (MICA-171, and MICA-172 once the
 * SDK-owned half moved in here) fails if anything under `sdk/` reaches the phone-owned
 * half. Adding a re-export here whose module lives in `lib/phone/` is the thing it
 * catches — move the module, or do not export it.
 */
export { isBrowser } from './lib/isBrowser';
export { filterByQuery } from './lib/filterByQuery';
export {
  formatCurrency,
  formatDate,
  formatDuration,
  formatRelativeTime,
  formatTime,
  formatTimestamp
} from './lib/formatters';
export { renderMarkdown } from './lib/markdown';
export { useScrollDetect } from './lib/useScrollDetect';
/**
 * Image encoding, and the downscale every photo is stored with (MICA-110).
 *
 * Here for the reason at the top of this file: the camera makes a thumbnail at capture
 * time and cannot import `lib/` by path (§2.7), and `boundary.test.ts` enforces it. An
 * app attaching an image has the same need, which is what makes this platform surface
 * rather than one app's helper.
 */
export {
  encodeCanvas,
  releaseCanvas,
  computeThumbnailSize,
  loadImage,
  thumbnailFromImage,
  makeThumbnail,
  THUMBNAIL_MAX_DIMENSION,
  THUMBNAIL_QUALITY
} from './lib/thumbnail';

/**
 * Split player-written text into styleable pieces — text, `@mention`, `#tag`.
 *
 * Re-exported so every app renders a mention the same way, and so there is one place to audit.
 * Lives in `shared/`, because the server needs the same definition to decide who a mention
 * notifies. `mentionedHandles` is that half, re-exported here when a caller needs it.
 *
 * It returns **data, not markup**, which is the point: each token goes to the DOM through
 * Svelte's `{text}` and escapes, so no sanitizer is involved because nothing is ever parsed as
 * HTML. Building an HTML string for `{@html}` is the alternative, and it is how a message
 * becomes script.
 */
export { tokenizeRichText } from '@gphone/shared/richText';

/**
 * Keep Tab inside a modal surface, and put focus back where it came from on close.
 *
 * **A deliberate widening of the published surface (MICA-172), and a one-way door.**
 * Three of the SDK's own primitives already use it — `ConfirmDialog`, `ReportDialog` and
 * `PhotoPickerModal` — and an add-on that needs a modal the kit does not ship had no way to
 * reach it. The alternative was for every add-on author to write their own trap, and a
 * hand-rolled focus trap is the kind of thing that is quietly got wrong: the surface still
 * looks right, Tab still moves, and the only person who finds out is a keyboard or
 * screen-reader user who was told "dialog" and handed the screen behind it. That is an
 * accessibility bug with no route back to its cause, which is exactly the class of failure
 * this repo would rather make impossible than document.
 *
 * Exported here rather than from a barrel line of its own because it is the same kind of
 * thing as everything above: DOM behaviour with no gPhone state behind it, implemented in
 * `sdk/lib/` and therefore bundle-safe for a sandboxed add-on. Going through `utils.ts` is
 * also what gives it index/addon parity for free — both barrels `export *` from this file,
 * so it cannot end up resolvable to the typechecker and missing at `vite build`, which is
 * the divergence `publicSurface.test.ts`'s parity arm exists to catch.
 *
 * `FocusTrapOptions` travels with it. An add-on wrapping this in a component of its own has
 * to name the options object to pass `enabled` or `returnFocusTo` through, and an action
 * whose parameter type is unnameable is an action you can only use in its default shape.
 *
 * ```svelte
 * <div role="dialog" aria-modal="true" use:focusTrap={{ returnFocusTo: () => opener }}>
 * ```
 */
export { focusTrap } from './lib/focusTrap';
export type { FocusTrapOptions } from './lib/focusTrap';

/**
 * The message to show a player for something that was thrown.
 *
 * The second half of MICA-172's widening, and public for a narrower reason than
 * `focusTrap`: an add-on cannot avoid catching. Every `useService(id).call(...)` can reject,
 * `useAppAction` hands a thrown value straight to a toast, and `catch` in TypeScript gives
 * you `unknown` — so the add-on author writes `err.message`, which throws a second time
 * inside the catch the first time a string or a `null` arrives instead of an `Error`. Four
 * SDK modules already route through this for that reason (`lazyBadge`, `ReportDialog`, and
 * both `appAction` facet twins); the fifth caller was always going to be an add-on.
 *
 * Takes the fallback as a required argument rather than defaulting one. There is no generic
 * message worth showing a player, and a default would put "Something went wrong" into every
 * add-on that forgot to think about it.
 */
export { messageOf } from './lib/errors';
