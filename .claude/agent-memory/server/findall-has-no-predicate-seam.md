# Repository.findAll has no seam for an extra predicate

`Repository.findAll` builds its `WHERE` from equality filters only, and its
helpers (`assertColumns`, `projectionFor`, `openProjected`) are `private`. A
subclass that needs one more condition, such as MICA-255's
`app NOT IN (unlisted apps)` on the generic accounts `get`, has to rebuild the
whole statement in an override.

The trap is that a rebuilt statement does not widen the projection for sealed
columns. So `AccountRepository.findAll` opens rows with `openRows` and nothing
more, and `Accounts.ts` throws at module load if `mica_accounts` ever gains an
encrypted column. Keep the base path (`super.findAll`) whenever the predicate
has nothing to add, so the SQL that `accounts.test.ts` pins stays
byte-identical.

Also: the generic public `get` with no `app` filter pages across **every** app's
accounts. Any per-app hiding has to cover the unfiltered call as well as the
`{ app }` one.

The test that would catch it: `accounts.policy.test.ts`, "excludes it from an
unfiltered page too".
