# A test-schema variant is one long scope

Each variant in `scripts/test-schema.js` (`runContentCipherVariant` and the
rest) is one async function hundreds of lines long. A new `const before` or
`const after` collides with one declared far above it in the same function. The
file then does not parse, and `pnpm test:schema` dies at load with a
`SyntaxError`, after minutes of Docker start-up when run in the background.

MICA-436 hit it twice in one lane, with `before` both times.

**How to apply:** name a new binding for what it holds (`tablesBefore`,
`usedBefore`), and run `node --check scripts/test-schema.js` before launching
the harness. `pnpm lint:ts` reports it as well
(`Identifier 'before' has already been declared`).

The harness's bundle already exports most of the server. A real `resolveDevice`
runs there (MICA-438) with a qb-shaped `rawPlayer` whose `GetItemByName` is the
real count path, and `GetConvar` wrapped for `mica_phone_item`. Restore the
convar in a `finally`.

**A check that a resolve creates a row needs a citizen nothing above touched.**
By that point the import and the seeds have given A and B phone rows through
`phoneForCitizen`, so a resolve for either creates nothing. The MICA-438 case
resolves a fresh `CIT_THIEF` (ESX: a `char2:` id) for "creates its own row".
