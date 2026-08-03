import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Svelte config.
 *
 * Every `a11y` warning used to be filtered out of both the compile and the dev path. That
 * is the general form of the specific bug `ListItem.svelte` documents fixing by hand, and of
 * `cf4d2de` ("every list in the phone ignored the keyboard") — with the filter on, an app
 * author got no dev-time signal for a click without a key handler, a missing label, or
 * invalid ARIA.
 *
 * Removing it turned out to cost one warning in the whole codebase, not the burst it was
 * assumed to be: the two fixes above had already dealt with the rest. That one is suppressed
 * at its own line, with the reason next to it, which is the difference between a considered
 * exception and a blanket.
 *
 * `pnpm check` runs with `--fail-on-warnings`, so these are now enforced rather than merely
 * visible — a warning nothing acts on is how the filter came to be here in the first place.
 */
export default {
  preprocess: vitePreprocess()
};
