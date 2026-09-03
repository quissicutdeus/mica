// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Scaffold an app.
 *
 * AGENTS.md §11 is seven steps, and five of them are the same five files every time.
 * Writing them by hand is where the omissions come from: the route table entry and the
 * browser mock are separate from the app that needs them, and a feature missing either
 * one fails silently — which is the single most common bug this codebase has shipped.
 *
 *   pnpm new:app journal              a UI-only app, like Calculator
 *   pnpm new:app journal --service    plus a server service, store, routes and mocks
 *   pnpm new:app journal --tablet     plus a tablet root, and the manifest line that shows it
 *
 * It writes the app directory and, with `--service`, the server declaration and client
 * store. It does not edit `shared/routes.ts` or the mock registry — those are tables a
 * human curates — so it prints exactly what to paste, and `pnpm verify` fails until you
 * have, because `routes.test.ts` cross-references all three layers.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const [, , rawId, ...flags] = process.argv;
const WITH_SERVICE = flags.includes('--service');
const WITH_TABLET = flags.includes('--tablet');

const die = (message) => {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
};

if (!rawId) die('usage: pnpm new:app <id> [--service] [--tablet]');

const id = rawId.toLowerCase();
if (!/^[a-z][a-z0-9_]*$/.test(id)) {
  die(
    `'${rawId}' must be lower_snake_case — it becomes a directory, an event segment and a table.`
  );
}

const appDir = path.join(ROOT, 'web/src/apps', id);
if (fs.existsSync(appDir)) die(`web/src/apps/${id} already exists.`);

/** "journal" -> "Journal", "crypto_tracker" -> "Crypto Tracker". */
const title = id
  .split('_')
  .map((word) => word[0].toUpperCase() + word.slice(1))
  .join(' ');

const Pascal = title.replace(/ /g, '');

if (title.length > 8) {
  console.warn(
    `\x1b[33mNote:\x1b[0m "${title}" is ${title.length} characters and will truncate under the ` +
      `launcher icon. "Administration" became "Admin" for this reason.\n`
  );
}

/**
 * Hand-written source carries its own SPDX header; `REUSE.toml` is the fallback for config and
 * generated files. `reuse lint` passes either way, so a scaffold that skipped this would drift
 * from the rest of the tree with nothing to report it.
 */
const spdxHeader = (relative) => {
  const notice = [
    `SPDX-FileCopyrightText: ${new Date().getFullYear()} quissicutdeus`,
    '',
    'SPDX-License-Identifier: AGPL-3.0-or-later'
  ];
  return relative.endsWith('.svelte')
    ? `<!--\n${notice.join('\n')}\n-->\n\n`
    : `${notice.map((line) => (line ? `// ${line}` : '//')).join('\n')}\n\n`;
};

const write = (relative, contents) => {
  const full = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, spdxHeader(relative) + contents);
  console.log(`  created  ${relative}`);
};

// --- the app itself ------------------------------------------------------------------

write(
  `web/src/apps/${id}/manifest.ts`,
  `import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk/app';

export default defineApp({
  id: '${id}',
  // The launcher tile. Add \`fg: 'text-gray-900'\` if you pick a light background —
  // the glyph inherits a near-white default that is unreadable on one.
  tile: { bg: 'bg-slate-500' },
  icon: Icon,
  description: 'TODO: one line, shown in the Store.',
  permissions: [],${
    WITH_TABLET
      ? `
  // Which frames the app appears on. Absent means the phone alone; listing the tablet
  // says the app is usable at 1280x800, which \`tablet.svelte\` beside this file provides.
  devices: ['phone', 'tablet'],`
      : ''
  }
  author: 'gPhone',
  // Required. \`false\` makes this an add-on: absent from the launcher, offered by the
  // Store, and uninstallable. Set it to \`true\` only for something that ships with the
  // phone and must not be removable.
  core: false
});
`
);

write(
  `web/src/apps/${id}/Icon.svelte`,
  `<script lang="ts">
  let { class: className = 'h-8 w-8' }: { class?: string } = $props();
</script>

<!-- Sized h-8 w-8 like every other launcher icon. -->
<svg class={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="2"
    d="M12 6v6l4 2M12 3a9 9 0 100 18 9 9 0 000-18z"
  />
</svg>
`
);

const dataImports = WITH_SERVICE ? `,\n  Skeleton,\n  onAppForeground,\n  use${Pascal}` : '';

write(
  `web/src/apps/${id}/index.svelte`,
  `<script lang="ts">
  import { EmptyState, Screen, useAppLevels, type AppProps${dataImports} } from '@gphone/sdk';

  // The annotation, not \`$props<AppProps>()\` — that form only works for an inline object
  // literal and reports "Expected 0 type arguments" for a named type.
  let { onback }: AppProps = $props();
${
  WITH_SERVICE
    ? `
  const { ${id} } = use${Pascal}();
  const loaded = ${id}.loaded;

  // Every visit, not once per session — apps stay resident (AGENTS.md §11).
  onAppForeground('${id}', () => {
    void ${id}.load();
  });
`
    : ''
}
  // Declaring the levels is what claims the Back key. Add a rung per screen, deepest
  // first; with none, Back simply leaves the app. \`appId\` is what keeps the claim
  // pointed at this app while it sits resident in the background.
  const app = useAppLevels({
    appId: '${id}',
    title: '${title}',
    onback: () => onback(),
    levels: []
  });
</script>

<Screen title={app.title} onback={app.back}>
  <div class="p-4">
${
  WITH_SERVICE
    ? `    {#if !$loaded}
      <Skeleton count={4} height="h-14" />
    {:else if $${id}.length === 0}
      <EmptyState title="Nothing here yet" description="TODO: say what will appear." />
    {:else}
      {#each $${id} as row (row.id)}
        <p class="text-sm text-gray-300">{row.id}</p>
      {/each}
    {/if}`
    : `    <EmptyState title="${title}" description="TODO: build the app." />`
}
  </div>
</Screen>
`
);

if (WITH_TABLET) {
  write(
    `web/src/apps/${id}/tablet.svelte`,
    `<script lang="ts">
  import { EmptyState, Screen, useAppLevels, type AppProps } from '@gphone/sdk';

  // The tablet root: rendered in place of index.svelte inside the 1280x800 frame, for an
  // app whose manifest lists 'tablet'. Same contract, same hooks; a wider layout. An app
  // that wants one root for both reads \`useDisplay().device\` instead of shipping this file.
  let { onback }: AppProps = $props();

  const app = useAppLevels({
    appId: '${id}',
    title: '${title}',
    onback: () => onback(),
    levels: []
  });
</script>

<Screen title={app.title} onback={app.back}>
  <div class="flex min-h-0 flex-1">
    <div class="border-outline-variant w-1/3 border-r p-4">
      <EmptyState title="${title}" description="TODO: the list, on the left." />
    </div>
    <div class="min-h-0 flex-1 p-4">
      <EmptyState title="${title}" description="TODO: the detail, on the right." />
    </div>
  </div>
</Screen>
`
  );
}

// --- keep the typed app contract covering it -----------------------------------------

/**
 * Add the app to `appContract.test.ts`.
 *
 * That file imports every app explicitly and assigns them to `Record<string, AppComponent>`,
 * which is the only way TypeScript can actually check an app against `AppProps` — the
 * registry loads apps through `import.meta.glob`, and Vite types that result by assertion
 * rather than by knowing what the modules export.
 *
 * Written rather than printed, because the companion test compares the list against the
 * directories on disk: leaving it to a human would mean `pnpm new:app` handed you a repo
 * that failed the `pnpm verify` it tells you to run next. That exact bug has been fixed here
 * once already.
 */
const registerInAppContract = () => {
  const relative = 'sdk/appContract.test.ts';
  const full = path.join(ROOT, relative);
  let contract = fs.readFileSync(full, 'utf8');

  if (contract.includes(`../web/src/apps/${id}/index.svelte`)) return;

  const importLine = `import ${Pascal} from '../web/src/apps/${id}/index.svelte';`;
  const imports = [
    ...contract.matchAll(/^import \w+ from '\.\.\/web\/src\/apps\/\w+\/index\.svelte';$/gm)
  ].map((m) => m[0]);
  // An empty match would make the `replace` below an insert at index 0 — String.replace('', x)
  // prepends — which silently fuses the new import onto whatever line 1 happens to be. Louder
  // to stop here than to hand back a file that no longer parses the way it reads.
  if (imports.length === 0) {
    throw new Error(
      `${relative}: found no '../web/src/apps/<id>/index.svelte' imports to sort against. ` +
        'The path this script writes has drifted from the one the file uses; fix it here.'
    );
  }
  const sortedImports = [...imports, importLine].toSorted((a, b) => a.localeCompare(b));
  contract = contract.replace(imports.join('\n'), sortedImports.join('\n'));

  const entries = contract.match(/const APPS: Record<string, AppComponent> = \{\n([\s\S]*?)\n\};/);
  const rows = entries[1]
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter(Boolean);
  const sortedRows = [...rows, `${id}: ${Pascal}`].toSorted((a, b) => a.localeCompare(b));
  contract = contract.replace(
    entries[0],
    `const APPS: Record<string, AppComponent> = {\n${sortedRows.map((r) => `  ${r}`).join(',\n')}\n};`
  );

  if (WITH_TABLET) {
    const tabletImport = `import ${Pascal}Tablet from '../web/src/apps/${id}/tablet.svelte';`;
    contract = contract.replace(importLine, `${importLine}\n${tabletImport}`);
    const roots = contract.match(
      /const TABLET_ROOTS: Record<string, AppComponent> = \{\n?([\s\S]*?)\n?\};/
    );
    if (!roots) {
      throw new Error(`${relative}: no TABLET_ROOTS map to register the tablet root in.`);
    }
    const rootRows = roots[1]
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .filter(Boolean);
    const sortedRootRows = [...rootRows, `${id}: ${Pascal}Tablet`].toSorted((a, b) =>
      a.localeCompare(b)
    );
    contract = contract.replace(
      roots[0],
      `const TABLET_ROOTS: Record<string, AppComponent> = {\n${sortedRootRows.map((r) => `  ${r}`).join(',\n')}\n};`
    );
  }

  fs.writeFileSync(full, contract);
  console.log(`  updated  ${relative}`);
};

registerInAppContract();

// --- the data half -------------------------------------------------------------------

if (WITH_SERVICE) {
  write(
    `server/services/${Pascal}.ts`,
    `import { defineService } from '../lib/defineService';

/**
 * TODO: say what this service owns, and why any non-generic action exists.
 *
 * Repository, write allowlist, CRUD events and DDL are all derived from this. Run
 * \`pnpm generate:sql\` afterwards and apply the file.
 */
export const ${id} = defineService({
  id: '${id}',
  access: { read: 'owner', write: 'owner' },
  schema: {
    title: { type: 'string', length: 100, notNull: true }
  }
});
`
  );

  write(
    `web/src/services/${id}.ts`,
    `import { createCrudStore, byNewest } from './createCrudStore';

export interface ${Pascal}Row {
  id: number;
  citizenid: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export const ${id} = createCrudStore<${Pascal}Row, Pick<${Pascal}Row, 'title'>>(
  '${title}',
  {
    list: 'get${Pascal}',
    create: 'create${Pascal}',
    update: 'update${Pascal}',
    remove: 'delete${Pascal}'
  },
  { sort: byNewest<${Pascal}Row>('updated_at') }
);
`
  );

  write(
    `sdk/host/use${Pascal}.ts`,
    `import { ${id} } from '../../services/${id}';

/** OS Service Hook for ${title}. */
export function use${Pascal}() {
  return { ${id} };
}
`
  );
}

// --- the generated barrel ------------------------------------------------------------

if (WITH_SERVICE) {
  // `sdk/host/index.ts` is generated and committed, and until now only `build`
  // and `watch` regenerated it. `pnpm verify` typechecks long before it builds, so the
  // app this script had just written failed its own closing instruction — on the one
  // import the script itself generated. Doing it here fixes the barrel, but the tree is
  // not coherent the moment the scaffold finishes: `permissions.ts`, `manifest.ts`, and
  // the app's own `permissions` array are hand-curated and still missing. The third
  // printed block below says so; `permissions.test.ts` is what will name the gap if it's
  // skipped.
  await import('./generate-barrels.js');
}

// --- what is left, and why it is not generated ---------------------------------------

console.log(`\n\x1b[1m${title} scaffolded.\x1b[0m`);
console.log(
  `\nNothing registers the app — \`shell/state/registry.ts\` globs \`apps/*/manifest.ts\`,\n` +
    `so the directory is the whole installation step.\n`
);

if (WITH_SERVICE) {
  console.log(`\x1b[1mTwo tables are curated by hand. Paste into each:\x1b[0m\n`);
  console.log(`  \x1b[2mshared/routes.ts\x1b[0m — inside ROUTES`);
  console.log(`    // ${title}`);
  for (const [action, server] of [
    [`get${Pascal}`, 'get'],
    [`create${Pascal}`, 'create'],
    [`update${Pascal}`, 'update'],
    [`delete${Pascal}`, 'delete']
  ]) {
    console.log(`    route('${action}', '${id}', '${server}'),`);
  }
  console.log(`\n  \x1b[2mweb/src/nui/mocks/registry.ts\x1b[0m — inside mockRegistry`);
  console.log(`    ...defineMockCrud<${Pascal}Row>(mock${Pascal}, {`);
  console.log(
    `      list: 'get${Pascal}',\n      create: 'create${Pascal}',\n` +
      `      update: 'update${Pascal}',\n      remove: 'delete${Pascal}'\n    }),`
  );
  console.log(`\n  and a \`mock${Pascal}\` fixture array in \`web/src/nui/mocks/data.ts\`.`);
  console.log(
    `\n\x1b[2mThey are not generated because they are tables a human curates, and a bad\n` +
      `merge into one is worse than a missing line. \`pnpm verify\` fails until both are\n` +
      `there — routes.test.ts cross-references every layer.\x1b[0m`
  );
  console.log(`\nThen: \x1b[1mpnpm generate:sql\x1b[0m and re-import \`gphone.sql\`.`);

  console.log(`\n\x1b[1mThe permission table is also hand-curated. Update it:\x1b[0m\n`);
  console.log(
    `  \x1b[2msdk/permissions.ts\x1b[0m — add a row \`use${Pascal}: '${id}'\`, unless the\n` +
      `  new hook is only ever called by ${title}'s own store through \`useService\`, in\n` +
      `  which case no hook file and no row are needed at all.`
  );
  console.log(
    `\n  \x1b[2msdk/manifest.ts\x1b[0m — add '${id}' to \`ALL_PERMISSIONS\` (and so to the\n` +
      `  \`AppPermission\` union it derives).`
  );
  console.log(
    `\n  \x1b[2mweb/src/apps/store/appInfo.ts\x1b[0m — a label for '${id}' in \`LABELS\`.`
  );
  console.log(
    `\n  \x1b[2mweb/src/apps/${id}/manifest.ts\x1b[0m — declare '${id}' in \`permissions\`.`
  );
  console.log(
    `\n\x1b[2mThis script does not write any of those for you. Skip a step and \`pnpm verify\`\n` +
      `will still pass the barrel/typecheck gates — \`permissions.test.ts\` is what catches\n` +
      `it, naming the exact app and hook that's undeclared.\x1b[0m`
  );
} else {
  console.log(
    `Then: \x1b[1mpnpm dev\x1b[0m and open \x1b[1mlocalhost:5173/?app=${id}\x1b[0m.\n` +
      `\n\x1b[2mNot the home screen: the template ships \`core: false\`, so this is an add-on and\n` +
      `the launcher does not carry it until it is installed from the Store. The \`?app=\`\n` +
      `link opens it either way. Set \`core: true\` only for something that comes in the\n` +
      `box and must not be uninstallable.\x1b[0m`
  );
}

console.log(`\nFinally: \x1b[1mpnpm verify\x1b[0m\n`);
