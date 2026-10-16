# A failure stub must follow fetchNui's contract, not just reject

`vi.spyOn(fetchNui).mockRejectedValue(...)` skips fetchNui's own default-value
handling: a real fetchNui given a default returns that default on failure
instead of throwing. Failure-path tests written that way passed against the old
fail-open passcode and balance reads, so they proved nothing.

**How to apply:** stub a failure the way the real layer fails: return the
default if the caller asked for one, otherwise throw. Then break the fix and
confirm the test goes red. And with `call` instead of `callOr`, a null reply
comes back as null, so guard every reply's shape. Found in the 2026-10-15
fail-open sweep (MICA-384 holds the rest).
