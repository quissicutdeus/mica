# e2e agent memory

One file per finding; this index is what loads. Read the file before relying on
its one-line summary.

- [Ports, timers and flakiness](flaky-tests-and-port-binding.md) — 4173 held on
  WSL2 is invisible to `ss`; never a fixed wait against an animation; how to
  prove a regression test fails without its fix
- [MICA-295 tablet parity](mica-295-tablet-parity.md) — notes/tablet.svelte uses
  variant=edit not add; sidebar row names are title+subtitle; two real a11y bugs
  found (status bar contrast in tablet light mode, ColorWheelPicker missing
  label)
- [MICA-311 dev add-on spec](mica-311-dev-addon-spec.md) — fixture built by the
  template's own vite config; `.svelte.src` for lint:web; boot refusals show
  only a toast; shared dist/web can be clobbered mid-run
