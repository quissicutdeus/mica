# A citizen-keyed phone cache outlives a handover

`Phones.ts` keeps `activeByCitizen`, which every resolve writes and nothing
clears. After a robbery it still names the phone the thief now holds. So
`phoneForCitizen(victim)` filed notifications, line texts and dropped photos on
the stolen phone under the victim, and the next handover walk gave them to the
thief (MICA-339 F7, which predates MICA-264).

The fix checks the cached phone against `holderNow` (a pending handover's
holder, then `holderOf`) before answering. It closes the window only once the
thief has resolved the phone in this process. Until then nothing records the
theft: the row, `holderOf` and the `mica_phones` fallback all still name the
victim.

**Decided, do not re-fix:** a phone out of the inventory can't be told stolen
from stashed; the owner chose stashed keeps receiving (MICA-339). A round that
marked a citizen whose resolve answered `'none'` and filed their rows on their
unclaimed identity phone was reverted for that reason: rows written while a
phone sat in a stash would stay off it when it came back out. The residual
window (a stolen phone receives the victim's new rows until the thief first
resolves it) is recorded in `docs/security.md`.

The test resolves the phone for the victim, then for a second citizen on another
source with the row still naming the victim, and then asks
`phoneForCitizen(victim)`. Assert the thief's answer too: a cache that simply
stopped answering would pass the victim half on its own.

Any new cache keyed by citizen or by source that names a device needs the same
question: what clears it when the device changes hands?
