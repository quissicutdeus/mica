# `s.none()` reads a JSON `null` as absent

`s.none()` (`shared/schema.ts`) accepts `undefined`, `null` and `{}`, and its
parse answers `undefined` for `null`. So a client that forwards `null` to a
`s.none()` action reaches the server's identical parse, even though the
forwarded value and the parsed value are not equal.

The trap is in an oracle that compares "what was forwarded" against "the
schema's parse" for equality: it goes red on every no-input action (27 of them
when MICA-466 tried it) for a difference that changes nothing. Compare the parse
of each side instead.
