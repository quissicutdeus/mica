# testing-library's `rerender` resets a component's `ready` flag

`rerender` in @testing-library/svelte re-runs a component's url effect, which in
`MusicFrame.svelte` sets `ready` back to `false`. No real caller does that: both
real callers bind `ready`. A test that drives a prop change through `rerender`
therefore tests a state the phone never reaches.

**How to apply:** for a component with a bound flag, render it through a small
fixture under `__fixtures__/` that binds the flag and exposes setters for the
props, as `BoundMusicFrame.svelte` does. Found on MICA-360.
