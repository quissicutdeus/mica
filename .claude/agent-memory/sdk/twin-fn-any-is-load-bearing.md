# The `any` in the twin `fn` helper is load-bearing

`sdk/host/iframe/facets/_shared.ts`'s `fn` is constrained as
`F extends (...args: any[]) => Promise<any>`. MICA-420 tried `never[]` and
`Promise<unknown>` to drop the lint disable: `typecheck:sdk` then failed 10+
twin members. Members typed as returning `void` (clockWrite, displayWrite,
keybindsWrite, locale) no longer infer `F`, nor does lifecycle's callback
argument, and the `as F` cast becomes TS2352.

**Why:** `F` is inferred from the contextual type at each call site, and only
`any` lets a `void`-returning in-process member stand as the twin's member.

**How to apply:** leave the disable in place; its reason is now in the
directive's `--` description. Removing it means changing the facet `Twin` types,
not the helper.
