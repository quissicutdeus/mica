# The checker's union order is not stable text

MICA-460. `checker.signatureToString` / `typeToString` order a union's members
by internal type id. Type ids are handed out in the order types get created
while checking, so the same declaration prints in a different order when the
program is built in a different order.

Measured on `5e384216`: with `publicSurface.test.ts`'s roots reversed,
`useAppRegistryWrite` reprinted its 41-member permission union in a new order,
and nothing else changed. An edit to an unrelated file can shift it the same
way.

**So any text baseline of checker output must canonicalize unions** before
comparing, or a sibling's unrelated edit turns it red and teaches a lane to
re-freeze without reading. `canonicalSignature` in `publicSurface.test.ts` does
this: parse the text back as `type __ = <text>;`, sort every `UnionTypeNode` by
its members' printed text, innermost first, reprint, collapse whitespace.

Sort unions only. Intersection and overload order are what the declaration says,
and resolution reads them in order.

To prove a canonical form is stable, diff three builds: roots in order, roots
reversed, and each entry built alone. All three must match.
