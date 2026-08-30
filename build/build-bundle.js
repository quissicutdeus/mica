import { build, context } from "esbuild";

const IS_WATCH_MODE = process.env.IS_WATCH_MODE === '1';

const TARGET_ENTRIES = [
  {
    // MICA-112: FXServer's server-side JS runtime defaults to Node 16, and the only
    // opt-in alternative is Node 22 via a `node_version` directive in fxmanifest.lua
    // (docs.fivem.net/docs/scripting-reference/resource-manifest/) — this repo's
    // (generated) fxmanifest.lua declares no `node_version`, so it runs on the default.
    // "node24" was never a real FXServer runtime; it just under-constrained esbuild and
    // let `server/tsconfig.json`'s honestly-conservative `lib: ["es2021"]` (see the
    // comment there) look like a stale mismatch instead of the correct number.
    target: "node16",
    entryPoints: ["server/server.ts"],
    platform: "node",
    outfile: "./dist/server/server.js",
  },
  {
    target: "es2021",
    entryPoints: ["client/client.ts"],
    outfile: "./dist/client/client.js",
  },
];

const buildBundle = async () => {
  try {
    const baseOptions = {
      logLevel: "info",
      bundle: true,
      charset: "utf8",
      minifyWhitespace: true,
      absWorkingDir: process.cwd(),
    };

    for (const targetOpts of TARGET_ENTRIES) {
      const mergedOpts = { ...baseOptions, ...targetOpts };

      if (IS_WATCH_MODE) {
        // --- NEW API FOR WATCH MODE ---
        // We must define a plugin to replicate the old 'onRebuild' logging behavior
        const watchLoggerPlugin = {
          name: 'watch-logger',
          setup(pluginBuild) {
            pluginBuild.onEnd(result => {
              if (result.errors.length > 0) {
                console.error(
                  `[ESBuild Watch] (${targetOpts.entryPoints[0]}) Failed to rebuild bundle`
                );
              } else {
                console.log(
                  `[ESBuild Watch] (${targetOpts.entryPoints[0]}) Successfully rebuilt bundle`
                );
              }
            });
          },
        };

        // Add the plugin to the options
        mergedOpts.plugins = [watchLoggerPlugin];

        // Create the context and start watching
        const ctx = await context(mergedOpts);
        await ctx.watch();
        console.log(`[ESBuild] Watching ${targetOpts.entryPoints[0]}...`);

      } else {
        // --- STANDARD BUILD ---
        const { errors } = await build(mergedOpts);

        if (errors.length) {
          console.error(`[ESBuild] Bundle failed with ${errors.length} errors`);
          process.exit(1);
        }
      }
    }
  } catch (e) {
    console.log("[ESBuild] Build failed with error");
    console.error(e);
    process.exit(1);
  }
};

buildBundle().catch(() => process.exit(1));
