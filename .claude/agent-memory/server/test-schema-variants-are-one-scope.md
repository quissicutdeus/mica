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
runs there with `FrameworkBridge.itemSlots` reassigned, and `GetConvar` wrapped
for `mica_phone_item`. Restore both in a `finally`.
