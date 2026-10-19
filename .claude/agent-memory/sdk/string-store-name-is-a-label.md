# A string-form store's name is a label, not the service

`createCrudStore(name, events, options)` sends `events` as NUI action names
unless `options.service` is set; `name` only labels console lines. In an add-on
frame there are no NUI names at all (`sdk/host/iframe/fetchNui.ts` refuses every
one), so `createCrudStore('journal', { list: 'get' })` failed every call,
`load()` swallowed it into a `console.warn`, and the skeleton stayed up forever.
`createPagedStore('feed')` had the same hole.

The fix throws at construction in a frame (string form, no `service`) and adds
an `error` readable to both stores. Defaulting `service` to `name` was rejected:
`permissions.test.ts`'s store scan reads a no-service first argument as a label,
so a defaulted `createCrudStore('contacts', …)` would pass that scan while
reaching another app's service. The shell would still refuse it, but the static
check would fail open.

**Why:** "am I in a frame" is `globalThis.origin === 'null'`, the opaque origin
of `sandbox="allow-scripts"` with no `allow-same-origin`, which is the same fact
`IframeHostServer` checks on every message. Do not use
`window.parent !== window`: FiveM loads each resource's `ui_page` inside its
root NUI page, so the phone itself is framed in game.

**How to apply:** a new SDK factory that picks a transport by name needs the
same frame check and a frame test (`vi.stubGlobal('origin', 'null')`, then
`vi.unstubAllGlobals()`). A member added to a published interface
(`PagedStore.error`) passes `publicSurface.test.ts` silently, because additions
are not reported. Ask for it to be written into the shape baseline, or a later
removal goes unreported too.
