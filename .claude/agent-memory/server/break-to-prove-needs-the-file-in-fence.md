# Breaking product code to prove a harness check needs it in your fence

Extending `test:endpoints` (MICA-304, lane Jesse), the lane-protocol move of
breaking the code under test with Edit, running the gate, and restoring was
refused: with `server/**` read-only in the brief, the auto-mode classifier
denied running the harness against a modified `server/services/Phone.ts`
(dropping `notifyParty`'s `src <= 0` guard, to show the MICA-277 checks go red).
The edit was restored and the proof was not made.

So a harness-only lane cannot show its new checks fire against the product code.
Say so in the report as a coverage gap, name the one-line break that would prove
it (file, line, what goes red), and leave it to the lead or a lane whose fence
includes the file. Do not retry by another route. When a brief asks for checks
that must be seen failing, ask for the file in the fence.
