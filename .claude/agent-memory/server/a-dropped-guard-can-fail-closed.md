# A dropped guard can fail closed downstream

Red-proving MICA-464's matrix, dropping `darkchat_messages:list`'s membership
check (`if (!member) throw notMember()`) left the suite green: the attacker's
call then threw on the sealed bodies further down and was answered
`server.generic`. A crash is a refusal by accident, and the matrix rightly saw
no leak. Dropping the members list's own check (`Darkchat.ts`, `members`) leaked
every alias at once and the matrix named it.

So pick a red-proof break where nothing after the guard needs the guarded value:
read the handler past the guard first. And a break the matrix must name can be
caught earlier by a hand-written flow — Messages' `requireParticipant` is, by
`leftThread` — so the run stops before the matrix starts; choose a guard no
earlier flow exercises, or the proof shows the wrong check.

Related: [[break-to-prove-needs-the-file-in-fence]].
