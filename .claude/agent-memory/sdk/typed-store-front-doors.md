# Typed store front doors over one implementation

MICA-313 put a declaration overload in front of `createCrudStore` and
`createPagedStore`. Each body moved into an unexported `crudStore`/`pagedStore`,
and the exported name became overloads plus a dispatcher. Four things were not
obvious:

- **The implementation signature has to be the loosest point both doors meet.**
  The store's return type is invariant: `subscribe` is covariant and `add` is
  contravariant. So no concrete `CrudStore<T, D>` is compatible with both
  overloads (TS2394). Source lint bans `any`, so the implementation returns
  `unknown` and takes `CrudOptions<never, never>`.
- **A conditional parameter type still infers.** `list: ListEvent<D, L>` answers
  `L` when the action fits and a template-literal sentence when it does not. TS
  infers `L` through both branches, so the error reads as
  `'"one"' is not assignable to '"'one' must answer a list: …"'`. A name that is
  not an action falls back to the constraint, so the message prints
  `AddonActionName<…>` with "Did you mean". Guard the union fallback
  (`IsOne<L>`) so it does not distribute into one sentence per action.
- **TS 6 and TS 7 report overload failures differently.** TS 6, which
  svelte-check and every add-on use, lists each overload's error. TS 7 lists
  only the last one. So putting the string form last costs nothing for authors.
  It reads worse only in the root `tsc` partition, which excludes tests anyway.
- **The server parses add-on input strictly.** `addonInputSchema` refuses
  unknown keys. A CRUD store sends the whole row to `update`, so that action
  must declare every row field. It also sends `{ id }` alone to `remove`, and a
  paged store sends `cursor` and `limit`. The types encode this. Without them,
  each mismatch would be an `invalid_args` on every call.

The permissions trace (`permissions.test.ts`) did not cover a store's `service:`
option until MICA-313 extended it to both factories. Before that, an in-process
core app could have named another app's service through a store with nothing to
catch it. For a sandboxed add-on, `serviceAllowed` refuses a foreign id at run
time either way.
