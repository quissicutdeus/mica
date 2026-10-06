# Errors across the iframe wall

An error class an add-on should be able to `instanceof` (or guard on) does not
survive `postMessage` by itself. MICA-310's `ServiceRefusal` needed three
places, and leaving out any one of them is silent:

- `IframeHostServer.ts`'s `fail` builds the posted `error` field by field from a
  class the shell constructed (never from whatever a thrown object carries), so
  nothing else — stack, `cause`, a hand-hung property — crosses.
- `sdk/host/iframe/messages.ts` widens the `ToFrame` reply's `error` type.
- `sdk/host/iframe/remote.ts`'s `remoteCall` rebuilds the class from the
  strings, validating each one; a partial reply stays a plain `Error`.

`sdk/host/iframe/devMock.ts` claims to settle "exactly as the real path does",
so a change to what the real path throws has to land there too, or an add-on
author sees one class in `pnpm dev` and another in game.

The only end-to-end test of the hop (frame twin, `IframeHostServer`, the shell's
`service` facet, `fetchNui`, and back) is the `realPath`/`crossWall` harness in
`sdk/host/iframe/devMock.test.ts`. Extend that rather than writing a second one.

An add-on's own server refusals (`addonError`) are keyless by design
(`server/lib/addonServices.ts`), so the only keys an add-on can ever see are the
endpoint's own: `server.rateLimited`, `server.notAuthenticated`,
`server.endpoint.appDisabled` and `server.generic`.
