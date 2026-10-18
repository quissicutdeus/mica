# The props baseline misreads an inline type

`publicSurface.test.ts`'s `propsDestructure` finds `= $props(` and walks back to
the nearest `}`. With an inline annotation
(`let { a }: { a: string } = $props()`) that `}` closes the **type literal**,
not the destructure. The type's body has no top-level commas (members end in
`;`), so it reads as one entry and the baseline records only the first member's
name.

That is why `MessageBar`'s frozen row is `['value']`: its `onsend`, `busy`,
`above` and the rest are pinned by nothing, so dropping one would pass the gate.
MICA-392 hit it writing `DmInbox`/`DmThread`: the live parse came back as
`appId` alone and the suite reported every real prop as "removed".

**Why:** the parser was written against `interface Props` components
(`ReportDialog`, `Avatar`), where the `}` before `=` is the destructure's own.

**How to apply:** a new exported component declares `interface Props { … }` and
destructures `}: Props = $props()`. A bare name in the baseline means "no
default", `name?` means "has a default", whatever the type says. Before trusting
an existing row, check the component's annotation style; an inline-typed
component's row is suspect. Fixing the parser re-freezes those rows, which is a
baseline edit to make deliberately, not on the way past.
