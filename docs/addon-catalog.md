# The add-on catalog

A `CatalogEntry` (`web/src/shell/state/catalog.ts`) is what an operator's Store
backend serves to describe an installable `core: false` add-on. It is not the
bundle, and the bundle is never read to fill in what the entry doesn't say.

```ts
interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  bundleUrl: string;
  /** Lowercase hex SHA-256 of the exact bytes at `bundleUrl`. Required. */
  sha256: string;
  color: string;
  icon?: string;
  /** What this app discloses it reaches for — shown to a player before they install it. */
  permissions: AppPermission[];
  /** The devices the app appears on: 'phone' and/or 'tablet'. Absent means the phone. */
  devices?: AppDevice[];
  /** Whether the phone should block this app while signal is out. Defaults to `false`. */
  requiresNetwork?: boolean;
  /** The exact origins the installed app's frame may `fetch()`. Defaults to none (MICA-24). */
  networkHosts?: string[];
}
```

`isCatalogEntry` (same file) validates a value has every field with the right
primitive type before anything downstream trusts it.

## Which catalog a server uses

**A server that sets neither convar offers the project's public catalog**
(MICA-237), `https://mica.gg/addons/sdk-<SDK_CONTRACT_VERSION>/catalog.json`,
with `mica.gg` allowed as a host. It is keyed by the SDK contract rather than by
release: the contract the shell checks at install is the one thing a remote
add-on's bundle must match. A remote add-on may have a server half (MICA-308),
but that half is the author's own FiveM resource, registered through
`RegisterService` and installed by the server owner beside micaOS. It is not in
the catalog and not fetched from it, so it changes nothing about what the
catalog is keyed on. An add-on whose service is not registered on a server
installs and opens, and each of its service calls fails: at once when the
service was registered and has since gone away, and after the phone's 15-second
request timeout when nothing ever registered it. It lists only add-ons this
resource does not already ship (below: a catalog entry replaces the bundled app
of the same id), so it never swaps a built-in for a remote copy — and while
every in-tree add-on ships in the resource, it is an empty array.

`shared/addonConfig.ts` resolves the two convars into one of three states, the
same way on the client and the server:

| `mica_addon_catalog`             | State   | Catalog            | Allowed hosts                     |
| -------------------------------- | ------- | ------------------ | --------------------------------- |
| never set                        | default | the public catalog | `mica.gg` plus `mica_addon_hosts` |
| an `https://` URL                | custom  | that URL           | exactly `mica_addon_hosts`        |
| `off`, or set to an empty string | off     | none               | none                              |

Both need `setr`, for a custom catalog and for `off` alike, because the
allowlist lives in the phone's own UI and a plain `set` never leaves the server.
With `set mica_addon_catalog off`, the server stops listing the catalog, but
every phone still resolves the default, keeps `mica.gg` allowed and keeps
rehydrating add-ons installed from it:

```cfg
setr mica_addon_hosts "store.example.com"
setr mica_addon_catalog "https://store.example.com/catalog.json"
```

**The catalog's own host must appear in the allowlist too** — micaOS holds the
catalog to the same list as the bundles on it, so there is one list rather than
two, and setting the catalog while forgetting the allowlist is the mistake that
makes the Store list nothing. The client prints the state in force at resource
start, and a line about that pairing when a custom catalog's host is missing.

**The server fetches the catalog, not the phone.** A phone used to fetch it at
boot and on every update check, which told the catalog's host the IP address of
every player on the server — acceptable for an operator's own host, not for a
default pointed at the project's. `server/services/Store.ts` answers
`store:catalog` from a cache (ten minutes, sixty seconds after a failure),
fetching over `https` only, from an allowed host, refusing redirects and bodies
over 1 MiB. The phone still downloads a bundle itself when a player installs it,
and again at every boot to rehydrate what is installed, and it checks that
bundle's host and hash exactly as before.

`client/services/RemoteApps.ts` reads both and answers a `remoteAppConfig` NUI
call with them; `web/src/shell/state/remoteAppConfig.ts` applies them at page
load, before the rehydration described below can run. That path is what makes
`setTrustedRemoteAppHosts` and `setRemoteCatalogUrl` reachable at all: until
MICA-126 nothing in a shipped build called either, so every claim in this file
was true of the code and false of any build you could run. The README's
Configuration section carries what to weigh before allowlisting a host.

In a browser — `pnpm dev`, or the built preview — there are no convars and no
server, so the mocks in `web/src/nui/mocks/registry.ts` stand in for both:
`remoteAppConfig` answers from two env vars, and `store:catalog` fetches the
catalog the way the server would. **Unset means `off` here**, not the public
catalog, so a dev or e2e run never touches a real host; the demo image sets
both. A `?mica_addon_catalog=` query parameter overrides it for one page load.
To walk the loop without a game running:

```sh
VITE_MICA_ADDON_HOSTS=store.example.com \
VITE_MICA_ADDON_CATALOG=https://store.example.com/catalog.json pnpm dev
```

## The manifest comes from the entry, not the code

`installFromCatalog`/rehydration build the app's `AppManifest` out of the
`CatalogEntry` fields directly — `name`, `color`, `icon`, `permissions`, and so
on. Nothing ever `import()`s the fetched bundle to ask it what it claims to be.
That used to be how a remote app's manifest was discovered — the old loader
executed fetched code to learn its manifest — and it meant a bundle's own code
decided what the Store showed a player before they installed it, which is
exactly the thing a catalog is supposed to prevent. That loader is gone. A saved
remote install from before this change is dropped on rehydration with a console
warning, since there is no path left to recover a manifest from it.

## Previewing an add-on without a catalog

An author does not need a catalog, a host or a server to see their add-on.
`pnpm dev` in `tools/addon-template/` serves the bundle and a `mica-dev.json`
entry from `127.0.0.1:5174`, and the demo phone loads it with
`?addonDev=http://127.0.0.1:5174/` (MICA-311). That path skips this page's hash
check and consent sheet and nothing else, exists only in the dev and demo
builds, and is described with its limits in `docs/security.md`.

## Fetch and verify

`installVerified` in `web/src/shell/state/registry.ts` is the one path both
`installFromCatalog` and boot-time rehydration use:

1. Refuse a `data:` `bundleUrl` outright — a catalog entry is external input,
   and a `data:` URL would run inline source with no host check and no hash to
   verify.
2. Refuse a `bundleUrl` whose host isn't on the trusted-remote-app allowlist
   (`web/src/shell/state/remoteAppSecurity.ts`'s `setTrustedRemoteAppHosts`/
   `getTrustedRemoteAppHosts`), empty until `mica_addon_hosts` fills it — so on
   a server that has set no convars this step refuses everything, which is the
   intended behaviour rather than a misconfiguration.
3. Fetch the bytes, hash them, and compare against `entry.sha256`. A mismatch
   refuses the install. A pinned hash re-verifies on every boot, not just at
   install time, so a bundle swapped out server-side after install is refused
   rather than silently re-run.
4. Only bytes that clear all three are handed to the sandboxed iframe to run.

## The bundle itself must be self-contained

A `core: false` add-on's build (`web/vite.addon.config.ts` +
`web/scripts/build-addons.mjs`, `pnpm --filter web build:addons`) produces one
minified, self-contained JS file per add-on — no import map, no runtime
dependency on anything the shell serves. The built-in add-ons land at
`web/public/addons/<id>.js` (gitignored); an operator-hosted catalog entry's
`bundleUrl` points at the equivalent file on their own host.

### Where a third-party bundle comes from

Neither of those two files is available to somebody who has not cloned this
repository, and the whole point of a catalog is that the interesting entries
come from people who have not. `tools/addon-template/` (MICA-175) is the
standalone project that closes that gap:

```sh
pnpm dlx degit quissicutdeus/mica/tools/addon-template my-addon
cd my-addon && pnpm install && pnpm build   # -> dist/<id>.js
```

It carries its own copy of the build decisions — one ES chunk with
`codeSplitting: false`, the stylesheet inlined into it, `target: 'chrome92'`,
minified, `__MICA_VERSION__` and `__MICA_BUILD_INFO__` substituted with the
empty string — so what it emits has the same shape a `bundleUrl` is expected to
serve. `web/src/lib/addonTemplate.test.ts` fails this repo's build if the two
configs stop agreeing on any of that.

Two things about it belong on this page rather than in the template:

- **It installs `@mica/sdk` and `@mica/shared` as git dependencies on this
  repository, because neither is published.** The template's README carries the
  four consequences (an `overrides` entry for the SDK's own `workspace:*`,
  `blockExoticSubdeps: false`, both in `pnpm-workspace.yaml` because pnpm 11
  ignores the `pnpm` field in `package.json`, and a ref that has to be `dev`
  today because `main` predates the packaged SDK).
- **The template refuses `@mica/sdk/core` and a `core: true` manifest at build
  time**, since `refuseCoreEntry()` and `sdk/boundary.test.ts` are both in files
  an outside author does not have. That is a courtesy that fails early. The
  boundary an operator is actually relying on is the one on this page — the host
  allowlist, the `sha256` check, and the sandboxed frame — plus the shell's
  re-check of every declared permission. **Nothing about a bundle's provenance
  is evidence about its contents**: a bundle built from the template is exactly
  as untrusted as any other bytes at a `bundleUrl`.

The bundle's `default`/`manifest` exports, if any, are not read by the shell —
that information now lives on the `CatalogEntry` instead (see above). What the
shell actually calls is `bootAddOn` (`@mica/sdk`, re-exported from
`sdk/host/iframe/boot.ts`), which the bundle's own entry code is expected to
invoke once it's running inside the sandboxed frame — `hello`-handshaking with
the shell, then waiting for `hydrate` before rendering. See
[`docs/writing-an-app.md`](writing-an-app.md#your-app-runs-in-a-frame) for what
the sandbox means for the app code itself, and [`docs/security.md`](security.md)
for the trust model this supports.

## Telling a player their copy is out of date

Both halves of the comparison always existed — the entry carries a `version`,
and `installVerified` copies that string onto the installed manifest — and
nothing put them together, so an install could sit behind a published fix
indefinitely (MICA-74). `web/src/shell/state/appUpdates.ts` is the join:

- **`fetchRemoteCatalog()`** (`web/src/shell/state/remoteCatalog.ts`, reached by
  core apps through `useAppRegistryWrite()`) asks the server for the catalog
  (`store:catalog`) and validates every entry with `isCatalogEntry`, dropping a
  bad row with a warning. The Store's listing, its install lookup and the update
  check all read it, so no phone fetches the catalog itself (MICA-237).
  `getRemoteCatalogUrl()`/`setRemoteCatalogUrl()` and `fetchCatalog()` stay
  exported in `catalog.ts` for add-on tooling.
- **`refreshAppUpdates()`** reads that catalog and compares. It runs from the
  Store's manifest `preload` (so the launcher badge is right before first paint)
  and again from its `onAppForeground`. A failed fetch **keeps the previous
  answer**: a catalog server that is down is not evidence anyone is up to date.
- **`compareVersions`** (`web/src/lib/phone/semver.ts`) does the ordering, and
  returns `null` for a pair it cannot order rather than guessing. `version` is
  an operator-authored string checked only for being non-empty, so `'1.10.0'` vs
  `'1.9.0'` and `'2.0'` vs `'2.0.0'` both have to come out right, and `nightly`
  has to come out as _unknown_.
- **An unorderable difference is shown as a version mismatch, never as
  "newer".** Saying nothing would be the silent "up to date" this exists to
  stop; claiming an update from a string inequality is the error in the other
  direction.
- **Updating reuses `installFromCatalog`.** The bundle is re-fetched and
  re-verified against the entry's `sha256` exactly as on a first install; there
  is deliberately no second install path for an update to skip verification in.
  It is user-initiated — a third-party code bundle should not swap itself out
  underneath a player, and the details screen that offers the button is the one
  that lists the permissions the new bundle will run with.

A **bundled** add-on is never offered an update: its code is part of this build,
so there is nowhere newer to fetch it from.
