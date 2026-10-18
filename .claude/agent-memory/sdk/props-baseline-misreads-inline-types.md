# The props baseline misread an inline type

Fixed in MICA-395: `publicSurface.test.ts`'s props parser now reads every form
in this tree (an `interface Props`, an inline type literal, a `$props<…>()` type
argument) and returns `null`, which the "read the props of every exported
component" guard fails on, for anything else. Fixtures for each form sit in its
"reads every props form, or refuses it" block.

The trap, for the record: `propsDestructure` used to walk back from `= $props(`
to the nearest `}`. With an inline annotation
(`let { a }: { a: string } = $props()`) that `}` closes the **type literal**,
not the destructure. Its members end in `;`, not `,`, so it read as one entry
and the baseline froze the first member's name alone. `MessageBar` sat at
`['value']` for months with every other prop pinned by nothing. MICA-392 caught
it when `DmInbox` and `DmThread` came back as `appId` alone.

**Why:** the parser was written against `interface Props` components, where the
`}` before `=` is the destructure's own. Prop additions pass the gate on
purpose, so a short row never failed anything.

**How to apply:** a new props form the parser cannot read fails loudly now. Fix
the parser and add a fixture for the form; never hand-write a row to get past
it. Each entry must be `name`, `'name'`, `name: local`, any of those with a
default, or `...rest` (`isDestructureEntry`), so a partial row cannot be frozen.
Because additions pass silently, check a new component's frozen row against its
real props by eye.
