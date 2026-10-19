# A whole-reply "no citizenid" check fails on fixture strings

A door scenario that proves a public projection withholds `citizenid` by
checking `JSON.stringify(reply).includes(citizenid)` is false trips on its own
fixtures when any of them carry the citizenid as a substring. Two ways it
happened on 2026-10-19 (glimpse.ts): a media URL built from the citizenid, and a
handle built with `unique()`, whose `itx_<run>_<n>_<label>` shape can equal a
citizenid seeded the same way. Build handles with another prefix (`g_…`) and
URLs that do not name the citizen, so the only way the citizenid can appear in a
reply is the leak the check is for.
