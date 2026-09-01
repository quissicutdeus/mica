import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  /**
   * Lowercase, `lower_snake_case`, and a **key** rather than a label: it is the bundle
   * filename, the storage namespace, the net-event segment, the keybind claim and the
   * deep-link scheme. Renaming it after anyone has installed the app is a data migration,
   * not a rename. `vite.config.ts` reads this line as text to name the output file, so
   * keep it a plain single-quoted literal.
   */
  id: 'my_addon',
  /**
   * The launcher tile. Both halves are **utility class names**, not colour values — a hex
   * string paints nothing and `defineApp` throws on one. Omit `fg` on a dark background;
   * state it on a light one, or the glyph inherits a near-white default and is illegible.
   */
  tile: { bg: 'bg-slate-500', fg: 'text-gray-900' },
  icon: Icon,
  description: 'One line, shown on the Store listing.',
  /**
   * What this app discloses it reaches for. The shell re-checks every one of these against
   * its own table before answering a call, so declaring less than you use does not buy
   * access — it only misleads the player reading the install prompt. Declaring more than
   * you use is merely untidy.
   */
  permissions: [],
  author: 'you',
  /**
   * Always `false` here, and `vite.config.ts` refuses to build anything else.
   *
   * `core: true` means the app ships inside the phone and cannot be uninstalled, and it is
   * the flag that gates `@gphone/sdk/core` — the raw NUI transport. A Store-installed
   * add-on runs in a sandboxed iframe whose only route to the shell is `postMessage`, so
   * `core: true` on a bundle built here would not grant the access it claims.
   */
  core: false
});
