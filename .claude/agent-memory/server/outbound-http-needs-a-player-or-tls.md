# Outbound HTTP in-server: https only, and `micahttp` for two of three

MICA-304's HTTP sink found two things no suite says.

Every outbound caller refuses anything but `https://` — `DiscordWebhook.ts`
(`webhookUrl`), `mediaHost.ts` (`parseHttps`), `Store.ts` (`refusalOf`) — so a
stub host has to speak TLS. `integration/lib/httpSink.ts` makes a self-signed
cert in process (`selfSigned.ts`, hand-written DER, since Node has no X.509
creation API) and sets `NODE_TLS_REJECT_UNAUTHORIZED=0` while a sink is open;
Node's TLS client reads it per connection. Its own `probe()` fetch fails the
scenario before micaOS is pointed at it, so a refused cert is never silence.
Whether FXServer shares `process.env` across resources is unproven until hoth.

Only the image host is reachable with no client by its own paths: `AddMedia`
uploads, the two `characterDeleted` events and `micamedia prune` release. Every
staff-relevant audit entry (the webhook) and `store:catalog` come from a
player's net event behind `ServiceEndpoint`'s `getPlayer`. Since MICA-322 the
console-only `micahttp webhook|catalog` (`server/services/OutboundHttp.ts`)
drives both through the same request — `DiscordWebhook.post`, the Store's
`fetchAndCache` — and `integration/scenarios/http.ts` runs it against the sink.
Still unproven in-server: the net-event half in front of each (a moderation
reaching `forwardAudit`, a phone's `store:catalog` reaching `readCatalog`).

Two traps the command hit. A webhook URL is its own secret (the token is the
path), so print `webhookOrigin(url)`, never `redactCatalogUrl`, which keeps the
path. And restoring `mica_addon_catalog` to `''` turns the catalog **off**;
restore an unset one by setting it to the `CONVAR_UNSET` literal.

The webhook's `fetch` follows redirects (no `redirect: 'error'`, unlike the
catalog), so a 3xx re-POSTs the body elsewhere; reported on MICA-322, not fixed.

Adding any scenario also means bumping `STANDALONE`/`QBX` in
`integrationRunner.test.ts` — a deliberate ratchet, outside a lane's usual
fence.
