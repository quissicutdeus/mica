# client agent memory

One file per finding; this index is what loads. Read the file before relying on
its one-line summary. A native that wanted an argument order its types did not
say, or a framework whose client object differed from its docs, goes in its own
file and gets a line here. A lesson every lane needs goes to `lane-protocol`
instead — the break-proof, scratchpad and warm-`.d.ts` notes moved there.

- [pma-voice call channel API](pma-voice-call-channel-api.md) — one call volume
  per client, server `setPlayerCall` syncs the state bag, no positional native
- [Raw net events are strict tuples](raw-net-events-are-strict-tuples.md) — an
  extra emitNet arg is dropped silently by guardNetEvent; server tuple first
- [The bare `exports` identifier is unreachable under Node](bare-exports-is-unreachable-under-node.md)
- [`s.none()` reads a JSON `null` as absent](s-none-reads-null-as-absent.md)
- [Every native can be stubbed from the typings](native-stubs-from-the-typings.md)
- [`Has*Loaded` stubs must answer true](has-loaded-stubs-must-answer-true.md)
- [An own `__proto__` key needs `JSON.parse`](own-proto-key-needs-json-parse.md)
- [Catch inside the async method](catch-inside-the-async-method.md) — a `.catch`
  at a fire-and-forget call site breaks sibling suites whose `vi.fn()` mock
  returns undefined
- [An open device closes itself unless the page answers `frameShown`](an-open-device-closes-itself-without-frameshown.md)
