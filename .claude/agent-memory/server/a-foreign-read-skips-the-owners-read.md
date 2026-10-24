# A read on somebody else's behalf can skip the owner's read

MICA-436 cached a claimed device row's owner in `ownerOf`, from any read. That
included a read made for somebody else: a thief's resolve, or the item gate's
read-only `usableSlot`. After it, the owner's own resolve took the hot path and
never read the row again in that process.

The first draft of `judgeRow` called `resumeSetup` only for the owner's row. A
restart between a set-up hook failing and its retry leaves `setup_pending = 1`,
and only a read of the row puts the hooks back in `owedSetup`. If a thief read
the phone first, the owner's resolve came from the cache, and the owed set-up
never ran for the rest of the process. Every suite was green until a test drove
that order.

**MICA-438 removed the path.** `ownerOf`, `judgeRow` and every read of another
citizen's row are gone: a resolve reads only its own citizen's rows
(`identityDevice`), so the one reader of a row is its owner, and `resumeSetup`
runs there. Concurrent asks for one citizen join the read in flight
(`pendingIdentity`), so they share its side effects instead of skipping them.

**The lesson stands:** a per-read side effect that only records belongs on every
read of the row, whoever it is for. When a cache can be filled by more than one
caller, list what the uncached path did besides answering, and check each still
happens for the caller who now hits the cache.

**Test that caught it then:** `defaultContactsRetry.test.ts`, now "is left alone
by somebody else's resolve after the restart, and finished by the owner's".

Related: [[citizen-phone-cache-outlives-the-holder]],
[[retried-seed-reads-every-status]]
