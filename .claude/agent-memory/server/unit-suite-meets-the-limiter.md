# A unit suite meets the limiter at 60 too

`registerEvent`'s limiter (`server/lib/rateLimit.ts`, 60 calls per source,
service and action a minute) runs inside every server suite that drives a real
handler, and its windows are module state that `vi.clearAllMocks` leaves alone.
A suite that calls one action more than 60 times from one source starts getting
`server.rateLimited` replies part-way through the file.

The symptom is misleading: whichever test crosses the line fails on a plain
assertion (`expected 'moderated' to be 'deleted'`), and the same test passes
alone under `-t`. MICA-426 hit it adding tests to `moderationRestore.test.ts`,
whose `it.each` over ten reportable tables already spent most of the
`reports:resolve` budget at source 5.

The fix is `__resetRateLimits()` from `../lib/rateLimit` in `beforeEach`, as
`spark.test.ts` and a dozen others already do. Suspect it first when a
handler-driven test passes alone and fails in the file.

The integration-door version of the same limit is
[door-loops-meet-the-limiter](door-loops-meet-the-limiter.md).
