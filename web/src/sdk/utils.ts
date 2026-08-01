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
export { isBrowser } from '../utils/isBrowser';
export {
  formatCurrency,
  formatDate,
  formatRelativeTime,
  formatTime,
  formatTimestamp
} from '../utils/formatters';
export { renderMarkdown } from '../utils/markdown';
export { useScrollDetect } from '../utils/useScrollDetect';
