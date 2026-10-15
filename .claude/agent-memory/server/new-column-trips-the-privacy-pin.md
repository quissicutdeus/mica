# A new column on an exported table fails privacy.test

`server/__tests__/privacy.test.ts` pins `EXPORTED_COLUMNS`, every column the
MICA-168 player export selects, table by table. A column declared on any owned
table fails it until someone adds it to the pin or withholds it in
`Privacy.ts`'s `WITHHELD`. A `private: true` column is not withheld by that
alone.

MICA-335 hit it with `mica_contacts.default_number`, `phone_key` and
`mica_devices.setup_pending`. My targeted vitest run was green. Only the full
`pnpm test:unit:server` run found it. The lead's ruling: withhold machinery (a
generated key column, a server bookkeeping flag) in `WITHHELD`, and export what
describes the player's own row (`default_number`), pinned in the test.

Both files are usually another lane's fence, because Privacy is its own ticket
stream. Run the whole server project before reporting a schema change, and name
the pin edit in the report instead of making it.

Related: [[dedupe-compares-as-the-key-does]]
