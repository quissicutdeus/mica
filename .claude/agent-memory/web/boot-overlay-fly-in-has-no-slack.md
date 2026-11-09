# The boot overlay's fly-in wait has no slack

Measured for MICA-450 (2026-11-08) in Chromium 103 at 4x CPU, n=5, by sampling
the phone frame's `getBoundingClientRect().top` every animation frame from its
insertion. The frame comes to rest at a median of 1017 ms after it enters the
DOM, and the boot overlay first shows at 1083 ms, about 65 ms later. The ~570 ms
long task at load holds both the fly-in and the overlay's `OPEN_FLY_MS` delay
back by about the same amount.

**Why it matters:** `BootScreen` is mounted beside the frame, not inside it, so
it does not travel with `transition:fly`. Showing it any earlier draws a black
box offset from a screen that is still moving. Cutting `OPEN_FLY_MS` below 500
buys at most ~65 ms at that risk, and in game, where GTA shares the CPU, the gap
is unmeasured.

**How to apply:** do not shorten the boot to gain time by trimming the fly-in
delay. The overlay's own duration is what to tune (`BOOT_MIN_MS`, `BOOT_EXIT_MS`
in `shell/state/power.ts`). Re-measure with a rAF sampler before changing
either.

Measuring cold start: Fives' `measure.mjs --cold-only` takes about 10 s a run. A
Forgejo CI job on this box pushed load to 20 and doubled FCP mid-session, so run
before and after interleaved, gated on `/proc/loadavg`, and compare only like
with like (cold-only against cold-only).
