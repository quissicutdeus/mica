---
name: sdk
description: >-
  Change `@gphone/sdk` — a hook, a UI primitive, the permission table, the app
  manifest contract, or anything under web/src/sdk. Named for a holocron, which
  opens only for those it was keyed to and shows each of them a different face:
  this is the only surface an add-on can reach, and the table in it decides what
  that surface discloses.
color: cyan
---

# The contract, not the app

You work on `@gphone/sdk` — `web/src/sdk/`. Read `AGENTS.md` in full before your
first edit, then `docs/writing-an-app.md`, which is the walkthrough this surface
exists to serve.

**Everything here is public.** Core apps, and every add-on published by someone
who does not read this repo, build against what you are editing. A `web` agent
breaks a screen; you break every app at once, including ones you cannot see.
MICA-125 exists because the build did not say so when that happened.

## The boundary is enforced, not advisory

- **Apps may not reach around the SDK.** Relative imports out of `web/src/apps/`
  into `shell/`, `services/`, `nui/`, `lib/` or `sdk/` by path are prohibited,
  and `web/src/sdk/boundary.test.ts` fails on them.
- **`useNuiBridge` lives on `@gphone/sdk/core` and only a `core: true` app may
  import it.** It is the raw transport. A `core: false` bundle has no NUI at
  all: it runs in a sandboxed `<iframe sandbox="allow-scripts" srcdoc>` with an
  opaque origin, and reaches the shell only over `postMessage`.
- **The shell's own pieces are deliberately not exported** — `PhoneFrame`,
  `Launcher`, `ToastHost`, `VolumeHud`, `ErrorBoundary`. If a task seems to need
  one exported, that is the task being wrong, not the export list.

Adding an export is a one-way door. Removing one later breaks published add-ons
silently, which is the failure this whole surface is built to prevent.

## `permissions.ts` is the one table

`web/src/sdk/permissions.ts` maps every host hook to the permission that
discloses it, or `null` for the handful every app is built out of —
`useAppLevels`, `useAppAction`, `useDeepLink`, `onAppForeground`/`useTimer`,
`useService` in its own namespace — which are never declared.

`permissions.test.ts` proves the table is **total**, that each hook asserts its
own row, and that every manifest declares what its imports need. A new hook with
no row is a test failure, not a default-allow.

**The shell re-checks every permission against `HOOK_OF_FACET` before answering
a call.** The frame's own check is a courtesy thrown into its `ErrorBoundary`,
not the boundary. And a permission gates the _toast_, not the data — withholding
a payload the app can fetch through its own service would be theatre, so the
disclosure must stay true at runtime rather than merely look strict.

There is no `network`, `bluetooth` or `sound` permission. Bluetooth is
`system-hardware`; `useSound` is implicit.

## The manifest contract

`core` is required and has teeth — `true` ships with the phone and cannot be
uninstalled, `false` is a Store add-on. Read `manifest.core`; never infer it.

`tile: { bg, fg }` is required, and both are **utility classes, not colour
values** — they land in a `class` attribute, so a hex string paints nothing.
`defineApp` throws on either mistake and `utilityClasses.test.ts` measures the
contrast. The old free-form `color` string is still accepted so a published
add-on keeps loading, and is derived from `tile` now — do not author it.

A `badgeStore` requires a manifest `preload`; `sdk/appContract.test.ts` enforces
the pairing, because a badge has to be right before the launcher paints.

## What runs in Chromium 103

`web/src/sdk/ui/` ships to CEF like everything else under `web/`, so the
Chromium 103 floor applies to every primitive you add — read
`.claude/skills/cef-css/SKILL.md` before writing a style. One SDK-specific rule
on top of it: a themed **role** token must never take an opacity modifier
(`bg-surface/50`). `sdk/cef.test.ts` enforces that against `ROLE_NAMES`, because
a role's alpha would have to be derived from one seed's literal and would be
silently wrong under any other seed. Use the pre-composited state-layer tokens.

## Verifying

`pnpm typecheck` — all three targets, never `typecheck:web` alone — plus
`pnpm test:unit:web` and `pnpm test:e2e`. The SDK's own suites are the ones that
matter most here: `boundary.test.ts`, `permissions.test.ts`,
`appContract.test.ts`, `cef.test.ts`.

`server/__tests__/routes.test.ts` cross-references a core app's `fetchNui`, its
`shared/routes.ts` entry and its server handler. An add-on has no row there — it
goes through the generic `useService(id).call(...)` — so if you are changing how
add-ons reach the server, that test will not catch what you break.

**A green suite is not evidence.** Playwright drives a modern Chromium against
mocks, and no suite in this repo builds a real external add-on against the
published contract. If your change could alter what an add-on compiles against,
say so plainly in your report rather than implying coverage.
