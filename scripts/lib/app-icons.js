// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Render an app's `Icon.svelte` to a standalone SVG `data:` URI.
 *
 * A manifest's `icon` is a Svelte component and `CatalogEntry.icon` is a string, and for a
 * while `generate-catalog.js` took that mismatch as proof the icon simply did not travel.
 * It does not travel *as a component* — but every consumer downstream already handles the
 * string form: `installVerified` copies `entry.icon` onto the manifest it builds, and
 * `AppIcon` renders `<img src={icon}>` when it is one. Emitting nothing meant a catalog
 * install got `null`, so the Store listed a coloured tile with no glyph and the home
 * screen kept it after install. Shipping the demo's own catalog is what exposed it: the
 * catalog's copy wins over the bundled one, and the catalog's copy had no icon to win with.
 *
 * A published `.svg` URL would have been less work and worse: another request per tile, a
 * second thing to publish, icons that vanish when the catalog host is down, and a remote
 * image load inside CEF, which is the class of change that passes Playwright and fails in
 * game.
 *
 * This lives apart from `generate-catalog.js` so it can be tested without a built `dist/`.
 * It throws rather than exiting, and the generator turns that into its own refusal.
 */

/** `AGENTS.md` §11: a tile that states no `fg` is a dark tile, and takes a light glyph. */
const GLYPH_ON_DARK_TILE = '#ffffff';

/**
 * What a glyph is painted in, once it can no longer inherit.
 *
 * `currentColor` is resolved here rather than left to the tile, because an `<img>` is a
 * document boundary — the SVG inside it cannot see the `color` the tile sets. The utility
 * classes resolve to literal colours in `sdk/app-utilities.css`, so the value is read from
 * there rather than restated: a second copy of `text-gray-900` is a second thing to update.
 *
 * One consequence worth stating plainly: a bundled icon follows a theme change and an
 * inlined one cannot. For a glyph sitting on a saturated tile that is arguably the more
 * correct of the two anyway — it has to contrast with the tile, not with the surface behind
 * it, and the tile does not change with the theme.
 */
const glyphColor = (id, fg, utilities) => {
  if (!fg) return GLYPH_ON_DARK_TILE;
  const declaration = utilities.match(
    new RegExp(
      `\\.${fg.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}\\s*\\{\\s*color:\\s*([^;]+);`
    )
  );
  if (!declaration) {
    throw new Error(
      `${id}'s tile states fg '${fg}', which sdk/app-utilities.css does not define. The icon ` +
        'is inlined into the catalog and cannot inherit a colour, so there is nothing to ' +
        'paint it with.'
    );
  }
  return declaration[1].trim();
};

/**
 * The rendered component as something an `<img>` can load.
 *
 * `xmlns` is added when the component omits it: legal in HTML, required in a `data:` URI,
 * and the difference between an icon that renders in `pnpm dev` and one that is blank
 * everywhere else. Percent-encoded rather than base64 — smaller, and it leaves the catalog
 * readable by a human deciding whether to trust it.
 */
const asDataUri = (id, body, color) => {
  const markup = body.replaceAll(/<!--[\s\S]*?-->/g, '').trim();
  const open = markup.indexOf('<svg');
  const close = markup.lastIndexOf('</svg>');
  if (open === -1 || close === -1) {
    throw new Error(
      `${id}'s Icon.svelte rendered no <svg> element. An icon that is not a standalone SVG ` +
        'cannot be inlined into a catalog entry.'
    );
  }

  let svg = markup.slice(open, close + '</svg>'.length);
  svg = svg.replaceAll('currentColor', color).replaceAll(' class=""', '');
  if (!svg.includes('xmlns=')) {
    svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

/**
 * Render every named app's icon, in the order given.
 *
 * `apps` is `{ id, fg }` — the tile's foreground class, or nothing for a dark tile. The
 * caller splits that out of the manifest with the SDK's own `tileFromColorClasses`, rather
 * than this file re-deriving it from a colour string with a regex that would drift.
 *
 * esbuild and Svelte are both resolved from `web`: they are root devDependencies, and the
 * demo image installs with `--filter web...` precisely to leave those out, so a bare import
 * works on a developer's machine and fails inside the container — the half that matters.
 */
export async function renderAppIcons({ root, appsDir, apps }) {
  const missing = apps.filter(({ id }) => !existsSync(join(appsDir, id, 'Icon.svelte')));
  if (missing.length > 0) {
    throw new Error(
      `${missing.map(({ id }) => id).join(', ')} has no Icon.svelte. A catalog entry with no ` +
        'icon lists a coloured tile with no glyph, in the Store and on the home screen after ' +
        'install.'
    );
  }

  const requireFromWeb = createRequire(join(root, 'web/package.json'));
  const { build, transform } = await import(pathToFileURL(requireFromWeb.resolve('esbuild')).href);

  // The compiler is CommonJS, so its named exports arrive behind the interop default rather
  // than on the namespace.
  const svelteCompiler = await import(
    pathToFileURL(requireFromWeb.resolve('svelte/compiler')).href
  );
  const { compile, preprocess } = svelteCompiler.default ?? svelteCompiler;

  /**
   * Compiles an icon to a server component, TypeScript stripped first.
   *
   * Svelte's compiler does not remove type annotations, and every icon declares its `class`
   * prop with one, so `preprocess` hands the script to esbuild before `compile` sees it.
   */
  const compileSvelte = {
    name: 'compile-svelte',
    setup(b) {
      b.onLoad({ filter: /\.svelte$/ }, async (args) => {
        const { code } = await preprocess(
          readFileSync(args.path, 'utf8'),
          {
            script: async ({ content, attributes }) =>
              attributes.lang === 'ts'
                ? { code: (await transform(content, { loader: 'ts' })).code }
                : undefined
          },
          { filename: args.path }
        );
        return {
          contents: compile(code, { generate: 'server', filename: args.path }).js.code,
          loader: 'js'
        };
      });
    }
  };

  const work = mkdtempSync(join(tmpdir(), 'gphone-icons-'));
  try {
    // `render` is bundled alongside the components rather than imported separately: a server
    // component and the runtime that renders it have to be the same copy of Svelte's
    // internals, and esbuild gives each bundle its own. `svelte/server` is resolved to a
    // path because this entry is written to a temp directory, where a bare specifier
    // resolves against nothing.
    const entry = join(work, 'icons.js');
    writeFileSync(
      entry,
      `${apps
        .map(
          ({ id }, i) => `import I${i} from ${JSON.stringify(join(appsDir, id, 'Icon.svelte'))};`
        )
        .join('\n')}
export { render } from ${JSON.stringify(requireFromWeb.resolve('svelte/server'))};
export default [${apps.map((_, i) => `I${i}`).join(', ')}];`
    );

    const out = join(work, 'icons.mjs');
    await build({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'warning',
      plugins: [compileSvelte],
      absWorkingDir: root,
      conditions: ['import']
    });

    const icons = await import(pathToFileURL(out).href);
    const utilities = readFileSync(join(root, 'sdk/app-utilities.css'), 'utf8');

    return apps.map(({ id, fg }, i) =>
      asDataUri(
        id,
        icons.render(icons.default[i], { props: { class: '' } }).body,
        glyphColor(id, fg, utilities)
      )
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
