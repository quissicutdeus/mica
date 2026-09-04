import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Matches micaOS's own `web/svelte.config.js`: `vitePreprocess()` and nothing else.
 *
 * In particular, no `onwarn` filter. micaOS removed one that had been suppressing every
 * `a11y` warning, and the cost of putting it back is that you stop being told about a
 * click handler with no keyboard equivalent or a missing label — in a UI whose users are
 * driving with one hand.
 */
export default {
  preprocess: vitePreprocess()
};
