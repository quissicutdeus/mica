/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module '*.svelte' {
  import type { ComponentType, SvelteComponent } from 'svelte';
  const component: ComponentType<SvelteComponent>;
  export default component;
}

declare const __MICA_VERSION__: string;
declare const __MICA_BUILD_INFO__: string;
declare const __MICA_GIT_BRANCH__: string;
declare const __MICA_GIT_COMMIT__: string;
