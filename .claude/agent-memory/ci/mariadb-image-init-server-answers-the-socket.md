# mariadb:noble's init server answers a root login on the socket, then vanishes

Found 2026-10-19: Release runs 39293409481 and 39294099614 both died at the
smoke wrapper's database wait, 5.7 s after `docker run`, which a loop of ninety
one-second tries cannot do on its own. On a first boot the image's entrypoint
starts a temporary server with `--skip-networking`, so it listens on the socket
and on no port. Probing a fresh `mariadb:noble` from inside one `docker exec`
(three runs, 2026-10-19), the socket answered `select 1` as root with the
password for only about 35 ms; two runs caught that window and the third's
probes fell either side of it. TCP refused throughout. Then neither answered for
1.2 to 2.1 s, until the real server was ready for connections, after which both
did.

A socket probe therefore lies: it passes against the temporary server, the loop
breaks, and the next call, here a second `ready ||` after the loop, meets the
gap and fails. A ping is no better, since the temporary server answers it before
the root password exists.

**How to apply:** probe readiness over TCP (`-h127.0.0.1 --protocol=tcp`), which
only the real server serves. Once TCP answers, the socket is the real server's
too, so later `docker exec -i ... mariadb` imports may stay on it. Record the
verdict inside the loop (`up=1; break`) and test that variable; a probe made
after the loop to decide is a second roll of the dice and can contradict a check
that already passed. The same shape applies to any readiness wait on an image
that runs a first-boot init server.

The fix is in `run_mode` of `scripts/deploy/mica-smoke-release.sh`. The "the
wait for the database" cases in `server/__tests__/smokeWrapper.test.ts` model
the window with `FAKE_DB_TIMELINE` (`temp`, `gap`, `up`) and fail on the old
loop with the production message, `did not accept a root login within 90s`.
