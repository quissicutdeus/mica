# Every native can be stubbed from the typings

`node_modules/@citizenfx/client/natives_universal.d.ts` declares each native as
one line, `declare function Name(...): Ret;`, and the return types are a small
closed set: `void`, `boolean`, `number`, `string`, `number[]`, `any`, and tuples
of those. Generating a stub per name that answers the zero of its return type
makes the whole of `client.ts` loadable with no hand-kept list.
`client/__tests__/nuiHarness.ts` does this (MICA-466), and a module that starts
calling a new native needs no edit there.

Leave anything `server/__tests__/setup.ts` already defines (`GetConvar`,
`RegisterCommand`, and others) as it is, because other suites rely on those
answers. Also see [[has-loaded-stubs-must-answer-true]].
