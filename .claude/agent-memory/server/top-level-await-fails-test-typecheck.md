# Top-level await in a server test fails typecheck:tests

A server suite that needs code to run before a module's dependents evaluate
cannot use `await import(...)` at the top of the file. Vitest runs it, but
`pnpm typecheck` reads `server/__tests__` through `server/tsconfig.tests.json`,
whose module setting refuses it: TS1378, "Top-level 'await' expressions are only
allowed when the 'module' option is set to 'es2022'…". The baseline is empty, so
the whole `typecheck` gate goes red on a suite that is green.

MICA-463 hit it. The hostile-payload sweep had to wrap the builders on `s`
before any contract called them, and the first version did that with a plain
statement followed by dynamic imports.

The way that typechecks is a `vi.mock` factory that patches the real module and
returns it:

```ts
vi.mock('@mica/shared/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mica/shared/schema')>();
  recordSchemaShapes(actual.s); // mutate in place
  return actual; // same objects, same SchemaError class
});
```

The factory runs the first time anything imports the module, before the importer
evaluates, so every import in the file can stay static. Returning `actual`
itself, not a spread copy of it, keeps `instanceof SchemaError` true across the
code under test.

Related: [[bridge-mock-lacks-a-new-export]]
