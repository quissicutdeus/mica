# Waiting on a first push across the iframe wall

MICA-265's `bootAddOn` tablet root picks a root from `display.device`, and has
to wait for the shell's first push before mounting anything. Two things a suite
here would not have shown up front:

- **A refused `subscribe` gets no reply at all.** `IframeHostServer.subscribe`
  logs and returns: no error message, no push. So an unknown member (a shell
  older than the member, here MICA-260's `device`) or a missing permission
  leaves the frame waiting forever. Anything the SDK awaits on a store needs a
  bounded wait with a fallback, and a check of `payload.permissions` up front
  (`boot.ts`'s `DEVICE_WAIT_MS`). `SDK_CONTRACT_VERSION` has been `'1'` since
  before MICA-260, so the contract check does not keep a new bundle off an old
  shell.
- **The seed hides the first push.** `remoteStore` is a `readable`, which drops
  a `set` equal to the current value, so a push of `'phone'` over a `'phone'`
  seed is invisible. Seed with `undefined` and treat the first defined value as
  the answer. `initial` is per caller, so this does not disturb an app's own
  `useDisplay().device` on the same shared wire.

Also learned writing the e2e: **a device switch rebuilds the add-on frame**
(2026-10-16; a mark left in the frame's `window` did not survive one), so a root
swapping inside a running frame is reachable from the unit suite only
(`bootTablet.test.ts`), not from Playwright.
