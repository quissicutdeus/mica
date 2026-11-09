# The bare `exports` identifier is unreachable under Node

In game, `exports['screencapture']` is FiveM's exports proxy. Under Vitest the
bare identifier resolves to the module's own exports object, so a test can never
reach the call through a stub on `globalThis.exports`. `Camera.ts`'s `takePhoto`
is the case: under test only its fallback-pixel branch ever runs, and its real
capture path is unswept (MICA-466).

`Call.ts` (`pmaVoice`) and `FrameworkBridge.ts` (`fx`) read
`(globalThis as any).exports ?? exports` for exactly this reason. Use that form
in any new code that calls another resource's export and needs a test to reach
it.
