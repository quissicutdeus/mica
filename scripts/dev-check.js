import { createServer } from 'node:net';

/**
 * Fails fast, with a clear message, if nothing is listening on the dev port — useful
 * before manually driving the phone in a browser. `pnpm test:e2e`/`pnpm verify` no
 * longer reuse this port at all (MICA-36 moved e2e to its own build on 4173), so this
 * check has nothing to do with e2e speed anymore. See docs/dev-loop.md.
 */

const PORT = Number(process.env.PORT ?? 5173);

const portInUse = () =>
  new Promise((resolve) => {
    const probe = createServer()
      .once('error', () => resolve(true))
      .once('listening', () => probe.close(() => resolve(false)))
      .listen(PORT, '127.0.0.1');
  });

const up = await portInUse();
if (up) {
  process.stdout.write(`Dev server is up on ${PORT}.\n`);
  process.exit(0);
}

process.stdout.write(
  `\nNothing is listening on ${PORT}.\n\n` +
    `Run \`pnpm dev\` in another terminal and leave it running for the session if you\n` +
    `want to manually drive the phone in a browser. It has no effect on \`pnpm test:e2e\`\n` +
    `or \`pnpm verify\`, which build and serve their own copy independently of this port.\n\n`
);
process.exit(1);
