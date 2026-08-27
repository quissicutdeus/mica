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
 * A missing tool falls back to running it in a container before it gives up, because
 * anyone working on the demo image already has Docker — that is what the image is. So in
 * practice these run for everyone, and "skipped" is reserved for a machine with neither
 * the toolchain nor a Docker daemon. `--no-docker` forces the local binaries only.
 *
 * CI passes `--require`, which turns a genuinely-unrunnable check into a failure. That is
 * what keeps "skipped locally" from quietly becoming "skipped everywhere".
 *
 *   node scripts/lint-container.js              local binaries, else Docker, else skip
 *   node scripts/lint-container.js --require    every check must actually run
 *   node scripts/lint-container.js --no-docker  never fall back to a container
 */
import { spawnSync } from 'node:child_process';

const REQUIRE = process.argv.includes('--require');
const NO_DOCKER = process.argv.includes('--no-docker');

/**
 * Is this tool installed and runnable?
 *
 * The probe is per-tool because `--version` is not universal, and guessing it wrong fails
 * *silently in the direction of "not installed"*. `go --version` is not a Go command: it
 * exits 2 with `flag provided but not defined: -version`. So this answered "no Go" on
 * every machine that had Go, the local branch below was dead code, and every check took
 * the Docker fallback instead.
 *
 * Nothing was wrong with the *result* -- the container runs the same checks against the
 * same pinned image -- which is exactly why it survived: the only visible trace was the
 * `(docker)` suffix in this script's own output. CI paid for it twice, installing a Go
 * toolchain it then never used and pulling golang:1-alpine to do work the installed Go
 * was standing right there to do.
 */
const has = (bin, probe = ['--version']) => spawnSync(bin, probe, { stdio: 'ignore' }).status === 0;

/** `go version` -- not `go --version`, which is an error. See the note on `has` above. */
const GO_PROBE = ['version'];

/**
 * Docker with a daemon actually answering, not merely a `docker` binary on PATH.
 *
 * `docker --version` prints happily with the daemon stopped, so `has('docker')` would
 * route every check into a container that cannot start and report four failures where the
 * honest answer is "skipped". `docker info` is the cheapest call that touches the daemon.
 *
 * Evaluated once, lazily: nothing pays for it on a machine that has the real toolchains.
 */
let dockerUsable;
const hasDocker = () => {
  if (NO_DOCKER) return false;
  dockerUsable ??= spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
  return dockerUsable;
};

/**
 * Pinned to the same major the Dockerfile builds the server with, so a `go vet` here
 * cannot pass against a different compiler than the one that produces the binary.
 */
const GO_IMAGE = 'golang:1-alpine';
const HADOLINT_IMAGE = 'hadolint/hadolint:latest';

/**
 * `docker run` wrapping one of the checks below.
 *
 * `--user` matters: without it the container writes as root, and anything Go leaves in a
 * mounted directory (it writes nothing today, but `go build` cache behaviour is not a
 * promise) comes back owned by root in the developer's working tree.
 */
const inDocker = (image, workdir, mount, args) => [
  'run',
  '--rm',
  '--user',
  `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
  '-v',
  `${process.cwd()}/${mount}:/w`,
  '-w',
  workdir,
  image,
  ...args
];

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

/** Why the Docker fallback was unavailable — a refusal and an absence are not the same. */
const noFallback = NO_DOCKER ? '--no-docker' : 'no Docker daemon';

// --- Go -------------------------------------------------------------------
// `go build` compiling is the cheapest way to catch what gofmt and vet both miss: code
// that is well-formatted, vet-clean, and does not build.
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GO_CHECKS = [
  { name: 'gofmt', argv: ['gofmt', '-l', '.'], failOnStdout: true },
  { name: 'go vet', argv: ['go', 'vet', './...'] },
  { name: 'go build', argv: ['go', 'build', '-o', NULL_DEVICE, './...'] }
];

if (has('go', GO_PROBE)) {
  for (const { name, argv, failOnStdout } of GO_CHECKS) {
    const [bin, ...args] = argv;
    check(name, bin, args, { cwd: 'docker/serve', failOnStdout });
  }
} else if (hasDocker()) {
  for (const { name, argv, failOnStdout } of GO_CHECKS) {
    // GOFLAGS=-mod=mod and a writable GOCACHE inside the container, not the mount: the
    // default cache path is $HOME/.cache, and `--user` gives the container a uid with no
    // home, so Go would fail on a cache it cannot create before it ever reads the source.
    check(
      `${name} (docker)`,
      'docker',
      [...inDocker(GO_IMAGE, '/w', 'docker/serve', ['env', 'GOCACHE=/tmp/go', ...argv])],
      { failOnStdout }
    );
  }
} else {
  skip('go', `no \`go\` and ${noFallback} — install Go, or let CI run it`);
}

// --- Dockerfile -----------------------------------------------------------
// The repo root is mounted, not just the Dockerfile: hadolint reads .hadolint.yaml from
// its working directory, and without it the DL3018 waiver documented there does not apply
// and this reports two findings that were deliberately accepted.
if (has('hadolint')) {
  check('hadolint', 'hadolint', ['--no-color', 'Dockerfile']);
} else if (hasDocker()) {
  check(
    'hadolint (docker)',
    'docker',
    inDocker(HADOLINT_IMAGE, '/w', '.', ['hadolint', '--no-color', 'Dockerfile'])
  );
} else {
  skip('hadolint', `no \`hadolint\` and ${noFallback} — install it, or let CI run it`);
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
