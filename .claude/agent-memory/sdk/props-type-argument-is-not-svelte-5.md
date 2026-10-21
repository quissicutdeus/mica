# `$props<T>()` was never Svelte 5, and 4.7.7 says so

svelte-check 4.7.6 accepted `$props<T>()` and typed it as `any`, so a component
written that way had no checked props at all. 4.7.7 (svelte2tsx 0.7.62) reads
the type argument as an error, "Expected 0 type arguments", and every caller
then sees the component's props as all **required**: one bad `Screen` turned
into some forty "missing `ontitleclick`, `actions`, `overlay`" errors across
`web/src/apps`. Fix the component, not the callers (MICA-403).

The form is `interface Props { ... }` then `let { ... }: Props = $props()`, as
the other sdk/ui components already do. Copy the member text across verbatim so
the external type cannot move.

**Why:** the cascade reads like dozens of broken call sites, and the tempting
fix is at the wrong end.

**How to apply:**

- `pnpm typecheck:sdk` runs svelte-check over `../web/src/apps` too, so an sdk
  lane cannot reach 0 errors while a web file still has the generic form. Name
  those files as the other lane's, do not edit them.
- The `BASELINE_PROPS` rows in `publicSurface.test.ts` mark `?` from the
  destructure's **defaults**, not from the type's optionality (FAB's optional
  `title` has no `?`). A green run there proves the destructure did not move;
  read the interface text against the old literal yourself.
