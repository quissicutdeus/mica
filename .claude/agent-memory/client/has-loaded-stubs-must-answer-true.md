# `Has*Loaded` stubs must answer true

`DeviceAnimation` polls `HasAnimDictLoaded` and `HasModelLoaded` every 10 ms
until they answer true or `GetGameTimer` passes a deadline. A stub that answers
`false` (the zero of `boolean`) holds `onCameraApp`'s NUI reply for the whole
load timeout, so a sweep reads it as "never answers the page". That is a harness
artefact, not a finding.

Answer true for both, and true for `DoesAnimDictExist` and `IsModelValid`. Under
fake timers, make `GetGameTimer` read `Date.now()` so the deadline still means
something.
