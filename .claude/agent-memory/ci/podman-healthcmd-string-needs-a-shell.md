# A plain-string Quadlet HealthCmd needs a shell the demo image lacks

The demo image is `FROM scratch`: one binary and one directory, no `/bin/sh`. In
a Quadlet unit, `HealthCmd=/mica-serve -health` becomes `CMD-SHELL`, which
Podman runs through `/bin/sh -c`, so the check fails every time; with
`Notify=healthy` the unit then never finishes starting, and the deploy's
`systemctl --user restart` hangs to its timeout. The JSON exec form,
`HealthCmd=["/mica-serve","-health"]`, is stored as `["CMD", ...]` and passes.
Seen live on hoth during the move to rootless Podman (2026-10-31).

Stating the check in the unit at all is needed because an image Podman builds is
OCI by default and keeps no `HEALTHCHECK` from the Dockerfile.
`scripts/deploy/mica-*.container` carry the JSON form and a comment saying why.
