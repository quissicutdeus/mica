# A shared wire type change is an SDK contract change

`sdk/vocabulary/messages.ts` declares `UIConversation extends Conversation` and
`UIMessage extends Message`, both from `shared/types.ts`. Removing a field from
a shared shape the server sends therefore removes it from the published
`@mica/sdk` surface too. `sdk/publicSurface.test.ts` ("breaks no add-on") fails
with `type field removed` lines, and only an `SDK_CONTRACT_VERSION` bump,
re-captured baselines and a CHANGELOG "Action required" entry clear it. sdk/ and
CHANGELOG are not the server lane's, so report it rather than editing them.

MICA-339 hit this when it removed `citizenid` from `Conversation` and `Message`.
`pnpm typecheck` was green the whole time. Only `pnpm test:unit:web` runs that
test, so a server lane running only the server suite never sees it.

Two more places held the leak in place as an expected answer:

- `scripts/test-endpoints.js` asserted the push's `senderName`, the very field
  being removed. Run `pnpm test:endpoints` whenever a push or reply changes
  shape: it is the one gate that executes the statements on real MariaDB.
- The web mocks (`web/src/nui/mocks/data.ts`) hydrated a full contact per
  participant, which hid that the UI depended on the server naming people.

Check before changing any `shared/types.ts` shape: grep `sdk/` for `extends` of
it, and run `pnpm test:unit:web` alongside the server suite.
