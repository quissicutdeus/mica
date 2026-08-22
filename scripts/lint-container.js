/**
 * Lint the things `pnpm format:check` cannot read: the Go server and the Dockerfile.
 *
 * Prettier has no parser for either, and knip does not scan them, so before this
 * existed the demo image's only gate was "did `docker build` happen to work" — which
 * says nothing about `gofmt`, and nothing about a `RUN` with an unguarded pipe.
 *
 * Neither toolchain is a dependency of this repo, and requiring a Go install before
 * anyone can `git push` a Svelte change would be a poor trade. So a missing tool is
 * reported as **skipped**, never as passed — the same distinction `scripts/verify.js`
 * draws in its summary, and for the same reason: a gate nobody ran is not a gate.
 *
 * CI passes `--require`, which turns a missing tool into a failure. That is what keeps
 * "skipped locally" from quietly becoming "skipped everywhere".
 *
 *   node scripts/lint-container.js             skip what is not installed
 *   node scripts/lint-container.js --require    every check must actually run
 */
import { spawnSync } from 'node:child_process';

const REQUIRE = process.argv.includes('--require');

const has = (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;

const results = [];

const check = (name, bin, args, options = {}) => {
  const out = spawnSync(bin, args, { encoding: 'utf8', ...options });
  // gofmt reports by *printing filenames*, not by exit code: it exits 0 whether or not
  // anything needs reformatting. Treating its stdout as the verdict is the only way to
  // make it a gate at all.
  const failed = options.failOnStdout
    ? out.status !== 0 || out.stdout.trim() !== ''
    : out.status !== 0;
  results.push({ name, failed, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() });
};

const skip = (name, reason) => results.push({ name, skipped: true, reason });

// --- Go -------------------------------------------------------------------
if (has('go')) {
  const cwd = 'docker/serve';
  check('gofmt', 'gofmt', ['-l', '.'], { cwd, failOnStdout: true });
  check('go vet', 'go', ['vet', './...'], { cwd });
  // Compiling is the cheapest way to catch the case gofmt and vet both miss: code that
  // is well-formatted, vet-clean, and does not build.
  check(
    'go build',
    'go',
    ['build', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', './...'],
    { cwd }
  );
} else {
  skip('go', 'no `go` on PATH — install Go, or let CI run it');
}

// --- Dockerfile -----------------------------------------------------------
if (has('hadolint')) {
  check('hadolint', 'hadolint', ['--no-color', 'Dockerfile']);
} else {
  skip('hadolint', 'no `hadolint` on PATH — install it, or let CI run it');
}

// --- report ---------------------------------------------------------------
let failed = 0;
let skipped = 0;

for (const r of results) {
  if (r.skipped) {
    skipped++;
    process.stdout.write(`  \x1b[2m· ${r.name.padEnd(10)} skipped — ${r.reason}\x1b[0m\n`);
    continue;
  }
  if (r.failed) {
    failed++;
    process.stdout.write(`  \x1b[31m✗ ${r.name}\x1b[0m\n`);
    if (r.output) process.stdout.write(`${r.output.replace(/^/gm, '      ')}\n`);
  } else {
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${r.name}\n`);
  }
}

if (skipped > 0 && REQUIRE) {
  process.stdout.write(`\n\x1b[31m--require: ${skipped} check(s) could not run.\x1b[0m\n`);
  process.exit(1);
}
process.exit(failed > 0 ? 1 : 0);
