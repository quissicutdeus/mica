# The real Shell renders in jsdom

`web/src/shell/Shell.test.ts` renders the actual `Shell.svelte`, not a stand-in.
It needs two things: `Element.animate` stubbed so the frame's transition calls
`onfinish`, and `openDevice` reset between renders, since it is module state
that outlives a test. A probe app under `__fixtures__/` (`ResidentProbe.svelte`)
registers a search provider and a Control Center tile, so a test can see what a
resident app has registered.

**How to apply:** when a change is about what the shell mounts, or when, assert
it on the real Shell this way rather than on a store alone. Found on MICA-356,
where a store-only test missed that unmounting a background app drops its search
hits.
