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
 */
export { isBrowser } from '../lib/isBrowser';
export { filterByQuery } from '../lib/filterByQuery';
export {
  formatCurrency,
  formatDate,
  formatRelativeTime,
  formatTime,
  formatTimestamp
} from '../lib/formatters';
export { renderMarkdown } from '../lib/markdown';
export { useScrollDetect } from '../lib/useScrollDetect';

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
export { tokenizeRichText } from '@shared/richText';

/** Blabber's unread-mention badge, for its manifest. Mirrors `unreadMailCount`. */
export { unreadMentions } from '../services/blabber';
