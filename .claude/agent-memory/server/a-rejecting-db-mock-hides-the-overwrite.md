# A Database mock that always rejects hides the overwrite

MICA-326's bug was "a failed read is treated as no row, so the default gets
saved over the real row". The obvious test is `dbMock.query.mockRejectedValue`
followed by "no write happened". It **passes on the broken code**: the save that
does the overwrite starts with its own `findAll`, and that read rejects too, so
the write never reaches `insert`/`update`. The mock fails the whole database,
while the bug needs a transient error that fails one read and lets the next one
through.

So when the claim is "a read error must not lead to a write", fail only the read
under test (`mockRejectedValueOnce`, or a counter keyed by the params when
another read comes first, as in a phone switch, which reads the old phone before
the new one) and let every later read succeed. Then break-to-prove against HEAD.
Of the first set of MICA-326 tests, the tick-into-the-new-phone case stayed
green on HEAD until it was rewritten this way.

Related: [[negative-check-needs-a-positive-twin]]. A "nothing was written"
assertion means nothing until the write path is shown to be reachable.
