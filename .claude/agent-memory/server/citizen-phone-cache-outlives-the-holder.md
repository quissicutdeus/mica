# A citizen-keyed phone cache outlives a robbery, on purpose

`Devices.ts` keeps `activeByCitizen`, which every resolve writes and nothing
clears. After a robbery it still names the phone the thief now holds.

Before MICA-436 that was a bug (MICA-339 F7). `phoneForCitizen(victim)` filed
notifications, line texts and dropped photos on the stolen phone under the
victim, and the next handover walk gave them to the thief. The fix checked the
cache against `holderNow`.

Since MICA-436 a phone is its first user's for good. The thief is refused it
(`judgeRow` answers `foreign`), nothing on it moves, and `activeByCitizen` is
only ever written for a phone the resolve found to be the caller's. So the cache
naming the taken phone is right: rows filed there wait for the owner, which is
MICA-339's "stashed keeps receiving" decision. `holderNow` is gone.

`devices.test.ts` "keeps filing a victim's rows on their phone while a thief
holds it" holds both halves: the victim's answer stays the phone, and the
thief's own rows never land on it.

Any new cache keyed by citizen or by source that names a device still needs the
question: who else can reach it, and what clears it?

Related: [[a-foreign-read-skips-the-owners-read]]
