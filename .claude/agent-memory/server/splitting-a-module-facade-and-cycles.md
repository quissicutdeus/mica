# Splitting a server module: the facade and the cycle

MICA-323 split `services/Media.ts` into `lib/media/` and `lib/orphanSweep.ts`
into `lib/sweep/`. Two traps, neither of which a typecheck catches.

**knip flags a facade re-export that only had in-file users before.** knip.jsonc
sets `ignoreExportsUsedInFile`, so an export nobody imported was fine while its
own file used it. Once it moves and the old file re-exports it, the re-export
has no user and `pnpm deadcode` fails (`resolveOwnerOverride`, four types).
Re-export only what has an importer outside the module
(`git grep -lw <name> -- server scripts integration`); the rest stays exported
from the submodule, where it is used in-file.

**A `lib/` helper must not import the service it was split from.** `media` is a
module-scope `const` in `services/Media.ts`; a helper importing it while Media
imports the helper is a cycle, and any module-scope use
(`table: media.resolved.table`, `registerOwnedExternal(...)`) hits the binding
before it exists. So everything that names `media` — the hard-delete paths, the
registrations, the commands — stayed in the service file, and only `media`-free
code moved. Keep every registration in the service, in its original order, and
keep the moved modules free of side effects.

**How the move was proved:** generate the new files from line ranges of
`git show HEAD:<file>` with a script (so nothing is retyped), then match each
range against the result whitespace-insensitively; only the ranges with a
deliberate prose edit should miss. Tests that `vi.mock('../lib/orphanSweep')`
(privacy.test) keep working because every caller still imports the facade path,
never a submodule.
