# Two server-side traps a typecheck or a scan finds after the code is written

**`node:crypto` is a hand-written shim** (`server/lib/nodeCrypto.d.ts`, outside
most fences). It has `randomBytes`, `createHash`, `createHmac`, the GCM ciphers
and `scrypt`, and no `randomInt`. `import { randomInt }` fails
`typecheck:server` with TS2305. For a uniform integer, draw 6 bytes
(`Number.parseInt(randomBytes(6).toString('hex'), 16)`, which is exact in a
double), then reject draws at or above `floor(2^48 / n) * n` before taking `% n`
(Casino's `secureInt`, MICA-82).

**`convars.test.ts` reads the convar name at the `GetConvar` call site.** A
helper such as `readInt(name, fallback)` that calls `GetConvar(name, …)` reports
`UNRESOLVED:name` and fails, even when every caller passes a named const. Call
`GetConvar(SOME_CONST, …)` directly at each site and give the helper the raw
string instead.

**Why:** both cost a gate round-trip after the code looked finished. **How to
apply:** check the shim before reaching for a Node builtin, and never route a
convar name through a parameter.
