import { createServer } from 'node:net';

/**
 * Fails fast, with a clear message, if nothing is listening on the dev port — instead of
 * `pnpm test:e2e`/`pnpm verify` silently eating the ~2.5 min cold-start tax to find out
 * the same thing 60 seconds later. See docs/dev-loop.md.
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
    `Run \`pnpm dev\` in another terminal and leave it running for the session —\n` +
    `Playwright and \`pnpm verify\` both reuse a server already on this port, so\n` +
    `starting one once removes the cold-start tax from every e2e run after it.\n\n`
);
process.exit(1);
