# The boot overlay rides inside the frame, black from the first flush

Until 2026-11-09 `BootScreen` was mounted beside the phone frame, not inside it,
so it could not travel with the frame's `transition:fly`. To avoid a black box
offset from a moving screen, it waited out `OPEN_FLY_MS` (500 ms) transparent,
and the frame flew in fully drawn: wallpaper, lock or home, status bar. The
owner saw "phone, boot, phone". As a z-auto sibling it also painted under the
frame's own z-60 layers (status bar, home indicator) and the z-80 cutout once
the fly's transform ended.

**Now:** `BootScreen` is the last child of each frame's screen (`PhoneFrame`,
`TabletFrame`) at `z-80`, so it moves with the fly. Its black has no animation
and no delay: it is opaque in the same flush that creates the frame. Only the
logo waits out `delayMs` before fading in. Home stays mounted underneath
(MICA-450 builds it under the boot), so the cover is what hides it.

**How to apply:** never give the boot's black a delay or a fade-in again; a boot
that starts transparent shows the phone first.
`web/e2e/boot-paint-order.spec.ts` samples every frame from navigation and fails
any frame where the phone is visible before the overlay covers it.
`Shell.boot.test.ts` pins the structure: inside the frame, last child, no delay,
nothing above it. The boot's length is still tuned by `BOOT_MIN_MS` and
`BOOT_EXIT_MS` in `shell/state/power.ts`; re-measure with a rAF sampler before
changing either.

Measuring cold start: Fives' `measure.mjs --cold-only` takes about 10 s a run. A
Forgejo CI job on this box pushed load to 20 and doubled FCP mid-session, so run
before and after interleaved, gated on `/proc/loadavg`, and compare only like
with like (cold-only against cold-only).
