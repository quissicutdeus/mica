# integration agent memory

One file per finding; this index is what loads. A trap a harness met that passed
every suite, or a stand-in that answered differently from the real thing, goes
in its own file and gets one line here: the link, its title stating the trap.
The detail lives in the file, so read it before relying on the title. No summary
after the link — `lane-protocol` has why. The `server` agent's index holds the
server traps these harnesses judge; read it too.

- [micaOS's own start-up passes race in-server scenarios](boot-passes-race-in-server-scenarios.md)
- [A test-schema variant is one long scope](test-schema-variants-are-one-scope.md)
- [A whole-database diff flakes on second-resolution timestamps](whole-db-diff-flakes-on-timestamps.md)
- [The endpoint harness runs every server timer on the wall clock](harness-timers-are-wall-clock.md)
