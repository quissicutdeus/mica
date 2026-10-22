# Turning off a service's generic CRUD fails three pins

MICA-414 disabled the blocklist's `get`/`create`/`delete`. The service's own
suite was the obvious edit; the full server run found two more:

- `deviceServices.test.ts` lists the services with **no endpoint action**
  (`noEndpointAction`). A service whose last generic event goes, with no custom
  action, joins that list.
- `uniqueKeyDecisions.test.ts` pins the services with
  `uniqueAfterDelete: 'revive'`. With no generic `create` there is nothing to
  revive through: switch to `{ optOut: '<reason>' }` (not DDL) and drop it from
  the reviver pin.

The reverse holds too: `genericCrudCallers.test.ts` (MICA-414) fails a generic
event nothing in `web/src` or `sdk` calls, so a new `defineService` whose app
does not use all four verbs needs the unused ones disabled in the same change.

A module-level "log once" set (the ESX refusal, MICA-421) needs a reset the
suite already runs: register it with `dropOn([...resource])`, which
`__setResourceLookup` triggers, or the first test that logs swallows the line
every later test asserts.
