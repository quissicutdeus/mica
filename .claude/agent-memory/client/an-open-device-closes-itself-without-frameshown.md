# An open device closes itself unless the page answers `frameShown`

Since MICA-475, `DeviceVisibility.openDevice` starts a `FRAME_SHOWN_TIMEOUT_MS`
(15 s) deadline after it sends `setVisible`. If no `frameShown` for that device
arrives before the deadline, it runs `closeDevice`.

A test that opens a device and then advances fake timers past 15 s will see the
device go down on its own unless something answers. That close releases focus,
sends `setVisible` false and stops the clock.

- `focusRelease.test.ts` models a live page in its native wrapper
  (`pageReceives`). It answers every show after 32 ms, and `page.draws = false`
  kills it. Use that rather than timing a case to finish under the deadline.
  Before the model existed, every case passed only because no `settle()` chain
  reached 15 s.
- A suite with its own stubs (`DeviceVisibility.test.ts`) counts the deadline as
  a timer: `vi.getTimerCount()` is 2 while a device is up, the clock plus the
  deadline.
- `frameShown(device)` is the answer. Call it after an open when a test must
  hold a device up longer.

On the page side, a rendered `Shell` gets a real `setVisible` from the dev
harness's seed (`seedBrowserPhone`) on every boot, so each render produces one
answer. `web/src/shell/Shell.frameShown.test.ts` waits for the seed, then
asserts at a known point (`tick()` plus every started answer), never after a
wall-clock wait. The page answers from the frame's `data-device-frame` root
being connected, not from `visible`, and uses no `requestAnimationFrame`, which
can stall while the game window is unfocused.
