# A read on somebody else's behalf can skip the owner's read

MICA-436 caches a claimed device row's owner in `ownerOf`, from any read. That
includes a read made for somebody else: a thief's resolve, or the item gate's
read-only `usableSlot`. After it, the owner's own resolve takes the hot path and
never reads the row again in this process.

The first draft of `judgeRow` called `resumeSetup` only for the owner's row. A
restart between a set-up hook failing and its retry leaves `setup_pending = 1`,
and only a read of the row puts the hooks back in `owedSetup`. If a thief read
the phone first, the owner's resolve came from the cache, and the owed set-up
never ran for the rest of the process. Every suite was green until a test drove
that order.

**Fix:** a per-read side effect that only records belongs on every read of the
row, whoever it is for. `resumeSetup` only records; `finishSetup` runs it, and
only a resolve that found the phone its caller's reaches that.

**Test that caught it:** `defaultContactsRetry.test.ts` "is left for the owner
when somebody else resolves the phone after the restart": restart, B resolves
(refused), then A resolves and the seed must finish.

**How to apply:** when a cache can be filled by more than one caller, list what
the uncached path did besides answering, and check each still happens for the
caller who now hits the cache.

Related: [[citizen-phone-cache-outlives-the-holder]],
[[retried-seed-reads-every-status]]
