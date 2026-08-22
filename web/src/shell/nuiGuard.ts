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
 * Real CEF delivers `SendNUIMessage` with a null/undefined `event.source` (there is no
 * window on the other end, just the client injecting into this page). The dev harness
 * (`devHarness.ts`) posts fixtures with `window.postMessage(fixture, '*')`, which arrives
 * back with `event.source === window`. Anything else — in particular an iframe's
 * `contentWindow`, which is what a `parent.postMessage` from inside the sandboxed frame
 * carries as its source — is refused.
 */
export function isTrustedNuiSource(event: MessageEvent): boolean {
  return event.source == null || event.source === window;
}
