# Overloaded hooks and generic types on the published surface

MICA-308 gave `useService` a second, typed overload and published generic types
computed from a type argument. Three suites read the surface by text or by
checker, and each needed teaching.

- **`permissions.test.ts` `findDefinition` read the first declaration.** An
  overloaded hook's first `export function` is a signature with no body, so the
  `guarded()` check reported "no guarded() call". It now reads the last one, the
  implementation. Put the general overload last too: `publicSurface.test.ts`
  freezes a hook's return from the last call signature, so the string form kept
  `useService: ['call', 'id']` unchanged.
- **A type computed from a type argument has no shape.** `AddonActionInput`,
  `AddonActionOutput` and `AddonHandlers` go in `NO_SHAPE_BY_RULE`, as
  `Translate` does. Worse, `keyof D['actions'] & string` reads as `string`'s own
  methods (`charAt`, `padEnd`...), so never freeze such a name in
  `BASELINE_TYPE_SHAPES`: it would promise the String prototype.
- **To see what the shape reader produces**, a `console.log` in the test is
  swallowed. A deliberately failing `expect(JSON.stringify(...)).toBe('x')`
  prints the value.

Additions needed no `SDK_CONTRACT_VERSION` move and no `sdkChangelog` row (no
permission row changed), only the baselines and a `CHANGELOG` author entry.

A `defaultValue` handed to an iframe twin crosses `postMessage`, so a Svelte
`$state` array there must be `$state.snapshot(...)`: a proxy cannot be cloned.
