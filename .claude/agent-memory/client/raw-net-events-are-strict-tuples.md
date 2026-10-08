# Raw net events are strict tuples

A `mica:server:*` event that the server handles with a raw `onNet` goes through
`guardNetEvent` (`server/lib/netGuard.ts`), which validates the whole argument
list against an `s.tuple`. One extra argument from the client fails the schema,
and the server drops the event without a reply or a log line. Nothing in the
client suites can see it, since `emitNet` is a stub there.

So never append an argument to a raw event client-side alone. Change the
server's tuple first, in the same commit. `ServiceEndpoint`'s events are the
exception: since MICA-264 they read `(cbId, data, device)`, and
`ServiceProxy.relay` always sends the device.
