# Negative sources are not one namespace

Three kinds of negative "source" live in one server process. `-1` is `emitNet`'s
broadcast target. A line call's far end comes from `services/Phone.ts`, which
counts down from `-2`, one per call, with no floor. The integration door's
synthetic players count down from `SYNTHETIC_SOURCE_MAX`. MICA-397 first set
that bound at `-1000`, and review found that 998 line calls in one process would
hand a line's far end a synthetic player's identity through `getCitizenId`. It
is `-1_000_000` now.

**Why:** every existing negative source relies on `getCitizenId` answering null
for it. Anything that makes the bridge answer for some negative sources breaks
that for whichever source lands in its range.

**How to apply:** before giving any negative source a meaning, grep for every
allocator that counts down (`nextLineSource`, the door's `nextSource`) and keep
the ranges apart by orders of magnitude. Pin the boundary with a test that asks
about the other allocator's range.
