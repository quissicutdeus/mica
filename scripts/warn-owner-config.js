// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseDefaultContacts,
  parseDefaultDock,
  parseDisabledApps
} from '../shared/ownerConfig.ts';

/**
 * Warn, at demo build time, when an owner convar the Dockerfile bakes into the web build
 * (MICA-234) is set to something its own parser would refuse.
 *
 * `shared/ownerConfig.ts`'s parsers are total on purpose -- a typo in `server.cfg` must not
 * stop the resource, so a malformed convar becomes the unconfigured answer plus the pieces
 * it rejected, never a throw. That is correct for a live server. It is wrong, silently, for
 * this build: a demo assembled from a bad value looks byte-for-byte like one assembled from
 * none, and "the build finished" is the only signal anyone watching gets. So this reads the
 * same three env vars the Dockerfile exports into `pnpm --filter web build`, runs them
 * through the *real* parsers -- not a second copy of the rules that could drift from them --
 * and prints what each one refused.
 *
 * Never fails the build: the resulting demo is genuinely usable either way (just short the
 * malformed pieces), and this has nothing to say when all three are unset, which is every
 * `pnpm demo` and every CI `container` build today.
 */

const checks = [
  ['VITE_MICA_DISABLED_APPS', parseDisabledApps],
  ['VITE_MICA_DEFAULT_DOCK', parseDefaultDock],
  ['VITE_MICA_DEFAULT_CONTACTS', parseDefaultContacts]
];

let sawRejection = false;
for (const [name, parse] of checks) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) continue;
  const { rejected } = parse(raw);
  if (rejected.length === 0) continue;
  sawRejection = true;
  console.warn(
    `warn-owner-config: ${name} rejected ${rejected.length} ${rejected.length === 1 ? 'entry' : 'entries'}: ${rejected.join(', ')}`
  );
}

if (sawRejection) {
  console.warn(
    'warn-owner-config: the demo will build and boot -- shared/ownerConfig.ts drops the ' +
      'rejected pieces rather than failing -- but check server.cfg (or the --build-arg) for a typo.'
  );
}
