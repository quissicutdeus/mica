/**
 * MICA-176. **First import, deliberately.** This is the shell's half of the SDK host
 * seam: it pulls every `sdk/host/inProcess/facets/*` module onto the graph so each
 * self-registers into `sdk/host/current.ts`'s registry. An add-on's entry
 * (`bootAddOn`) imports `sdk/host/iframe/registerFacets` instead, and nothing else decides
 * which set a bundle contains — the `facetSwap()` resolver plugin that used to rewrite the
 * per-hook specifier is gone.
 *
 * It has to run before `./shell/Shell.svelte` below: ES imports evaluate in source order,
 * and anything in the shell graph that reads a facet while its own module is initialising
 * would otherwise hit `host facet '<name>' is not loaded`.
 */
import './sdk/host/inProcess/registerFacets';
import { mount } from 'svelte';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import './app.css';
import App from './shell/Shell.svelte';

const app = mount(App, {
  target: document.getElementById('app')!
});

export default app;
