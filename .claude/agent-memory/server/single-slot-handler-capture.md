# A suite's captured handler is the last one registered

Most server suites capture `on`/`onNet` into a `Map<string, Function>` in
`vi.hoisted`, so `handlers.get('playerDropped')` is whichever module registered
it last. Battery, `PhoneOpenState`, `deviceItem`, `shell.ts` and `Devices.ts`
each register one.

In MICA-337 a break-to-prove mutation dropped the only use of an import from
`Battery.ts`. esbuild elided the import, `PhoneOpenState` then loaded later
(from the test's own dynamic import), its handler became the "last" one, and a
disconnect test failed for a reason that had nothing to do with the mutation.

Capture every handler per event as well (`everyHandler` in `battery.test.ts`)
and have a drop helper run them all. The suite's bridge mock then needs
`forgetSource`, because `shell.ts`'s handler calls it.
