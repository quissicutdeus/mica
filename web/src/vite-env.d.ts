/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module '*.svelte' {
  import type { ComponentType, SvelteComponent } from 'svelte';
  const component: ComponentType<SvelteComponent>;
  export default component;
}

declare const __MICA_VERSION__: string;
declare const __MICA_BUILD_INFO__: string;

/**
 * What CEF and the dev harness put on `window`.
 *
 * Declared rather than reached through `(window as any)` in eight places. Two of these
 * are CEF's — `invokeNative` is how `isBrowser()` tells a real phone from a browser tab,
 * and `GetParentResourceName` is how the NUI transport addresses the resource. The
 * `setX` ones are the dev harness, deliberately global so they can be called from the
 * browser console.
 */
interface Window {
  /** Present only inside CEF. Its absence is what `isBrowser()` checks. */
  invokeNative?: unknown;
  GetParentResourceName?: () => string;
  webkitAudioContext?: typeof AudioContext;

  // Dev harness, browser only.
  setBattery?: (value: number) => void;
  setDrainSpeed?: (multiplier: number) => void;
  setSignalLevel?: (level: number) => void;
  triggerTestToast?: (type?: 'message' | 'contact' | 'call' | 'email') => void;
}
