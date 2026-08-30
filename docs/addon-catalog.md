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
  /** Whether the phone should block this app while signal is out. Defaults to `false`. */
  requiresNetwork?: boolean;
  /** The exact origins the installed app's frame may `fetch()`. Defaults to none (MICA-24). */
  networkHosts?: string[];
}
```

`isCatalogEntry` (same file) validates a value has every field with the right
primitive type before anything downstream trusts it.

## Turning it on

**Nothing below happens on a server that has not configured two convars, and
that is deliberate.** Both are empty by default, and both need `setr`, because
the whole install path lives in the phone's own UI and a plain `set` never
leaves the server:

```cfg
setr gphone_addon_hosts "store.example.com"
setr gphone_addon_catalog "https://store.example.com/catalog.json"
```

`gphone_addon_hosts` is the allowlist step 2 below checks, and
`gphone_addon_catalog` is the URL the Store and the update check both fetch.
**The catalog's own host must appear in the allowlist too** — gPhone holds the
catalog to the same list as the bundles on it, so there is one list rather than
two, and setting the catalog while forgetting the allowlist is the mistake that
makes the Store list nothing. The client prints a line about that pairing at
resource start rather than leaving it to be discovered.

`client/services/RemoteApps.ts` reads both and answers a `remoteAppConfig` NUI
call with them; `web/src/shell/state/remoteAppConfig.ts` applies them at page
load, before the rehydration described below can run. That path is what makes
`setTrustedRemoteAppHosts` and `setRemoteCatalogUrl` reachable at all: until
MICA-126 nothing in a shipped build called either, so every claim in this file
was true of the code and false of any build you could run. The README's
Configuration section carries what to weigh before allowlisting a host.

In a browser — `pnpm dev`, or the built preview — there are no convars, so the
mock in `web/src/nui/mocks/registry.ts` answers with the same empty config a
stock server does. Two env vars stand in for the convars when you want to walk
the loop without a game running:

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

## Fetch and verify

`installVerified` in `web/src/shell/state/registry.ts` is the one path both
`installFromCatalog` and boot-time rehydration use:

1. Refuse a `data:` `bundleUrl` outright — a catalog entry is external input,
   and a `data:` URL would run inline source with no host check and no hash to
   verify.
2. Refuse a `bundleUrl` whose host isn't on the trusted-remote-app allowlist
   (`web/src/shell/state/remoteAppSecurity.ts`'s `setTrustedRemoteAppHosts`/
   `getTrustedRemoteAppHosts`), empty until `gphone_addon_hosts` fills it — so
   on a server that has set no convars this step refuses everything, which is
   the intended behaviour rather than a misconfiguration.
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

The bundle's `default`/`manifest` exports, if any, are not read by the shell —
that information now lives on the `CatalogEntry` instead (see above). What the
shell actually calls is `bootAddOn` (`@gphone/sdk`, re-exported from
`web/src/sdk/host/iframe/boot.ts`), which the bundle's own entry code is
expected to invoke once it's running inside the sandboxed frame —
`hello`-handshaking with the shell, then waiting for `hydrate` before rendering.
See [`docs/writing-an-app.md`](writing-an-app.md#your-app-runs-in-a-frame) for
what the sandbox means for the app code itself, and
[`docs/security.md`](security.md) for the trust model this supports.

## Telling a player their copy is out of date

Both halves of the comparison always existed — the entry carries a `version`,
and `installVerified` copies that string onto the installed manifest — and
nothing put them together, so an install could sit behind a published fix
indefinitely (MICA-74). `web/src/shell/state/appUpdates.ts` is the join:

- **`getRemoteCatalogUrl()`/`setRemoteCatalogUrl()`** (`catalog.ts`) hold the
  operator's catalog URL, unset until `gphone_addon_catalog` fills it, exactly
  like `setTrustedRemoteAppHosts`. It moved out of a `const` inside the Store
  app because the update check runs at phone-open, before the Store has ever
  been opened.
- **`refreshAppUpdates()`** fetches that catalog and compares. It runs from the
  Store's manifest `preload` (so the launcher badge is right before first paint)
  and again from its `onAppForeground`. A failed fetch **keeps the previous
  answer**: a catalog server that is down is not evidence anyone is up to date.
- **`compareVersions`** (`web/src/lib/semver.ts`) does the ordering, and returns
  `null` for a pair it cannot order rather than guessing. `version` is an
  operator-authored string checked only for being non-empty, so `'1.10.0'` vs
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
