# Proving outbound HTTP in-server: https only, and two of three need a player

MICA-304's HTTP sink found two things no suite says.

Every outbound caller refuses anything but `https://` — `DiscordWebhook.ts`
(`webhookUrl`), `mediaHost.ts` (`parseHttps`), `Store.ts` (`refusalOf`) — so a
stub host has to speak TLS. `integration/lib/httpSink.ts` makes a self-signed
cert in process (`selfSigned.ts`, hand-written DER, since Node has no X.509
creation API) and sets `NODE_TLS_REJECT_UNAUTHORIZED=0` while a sink is open;
Node's TLS client reads it per connection. Its own `probe()` fetch fails the
scenario before micaOS is pointed at it, so a refused cert is never silence.
Whether FXServer shares `process.env` across resources is unproven until hoth.

Only the image host is reachable with no client: `AddMedia` uploads, the two
`characterDeleted` events and `micamedia prune` release. Every staff-relevant
audit entry (the webhook) and `store:catalog` come from a player's net event
behind `ServiceEndpoint`'s `getPlayer`, so those two are proven only by
`integrationHttpSink.test.ts`, under real Node fetch outside FXServer.

Adding any scenario also means bumping `STANDALONE`/`QBX` in
`integrationRunner.test.ts` — a deliberate ratchet, outside a lane's usual
fence.
