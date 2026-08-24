/**
 * Is this `message` event allowed to reach the NUI router?
 *
 * `Shell.svelte`'s `handleMessage` used to route any `{ action, data }` shape with no
 * check on where it came from — and a sandboxed add-on iframe can `parent.postMessage`
 * with exactly that shape (`{ action: 'installApp', ... }`, `uninstallApp`, `openApp`,
 * `notify`, ...) to reach every NUI-triggered path with none of the permission checks
 * `IframeHostServer` enforces. An add-on's only legitimate door into the shell is that
 * server, which the frame's own `message` listener (in `AddOnFrame`) already owns.
 *
 * Real CEF (verified live against Chrome/103.0.5060.141, the documented CEF baseline —
 * see AGENTS.md §6) delivers `SendNUIMessage` with `event.source === window.top`, the
 * root `nui://game` window gPhone's own frame is embedded in — not null/undefined as
 * previously assumed here, which silently discarded every real NUI message including
 * `setVisible` and left the phone permanently blank. The dev harness (`devHarness.ts`)
 * posts fixtures with `window.postMessage(fixture, '*')`, which arrives back with
 * `event.source === window`. Anything else — in particular an iframe's `contentWindow`,
 * which is what a `parent.postMessage` from inside the sandboxed frame carries as its
 * source, and which is neither `window` nor `window.top` from here — is refused.
 */
export function isTrustedNuiSource(event: MessageEvent): boolean {
  return event.source == null || event.source === window || event.source === window.top;
}
