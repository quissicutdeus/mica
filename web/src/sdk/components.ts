/**
 * UI primitives apps are allowed to build with.
 *
 * The SDK exported services but not components, so every app reached into
 * `../../components/` by relative path — nine of them, `Screen` most of all. That works
 * only for apps that live inside this repo. An add-on installed from the Store resolves
 * `@gphone/sdk` and nothing else, so anything not re-exported here is unreachable to it,
 * and the app-registry story only half works.
 *
 * Deliberately not everything in `components/`. `PhoneFrame`, `Home`, `ToastContainer`,
 * `VolumeHud` and `ErrorBoundary` are the shell itself — an app rendering its own phone
 * frame or toast host is a bug, not a feature.
 *
 * `SegmentedControl` and `ToggleSwitch` were written and then left out of this list,
 * which made them unreachable — so Settings inlined its own switches and Admin and Store
 * their own tab bars, one of which never rendered an active state at all. A primitive
 * nobody can import is not a primitive.
 *
 * Nothing speculative, either. `ActionSheet` was written, exported, and used by no app;
 * it is deleted rather than kept warm for an app that might want it.
 */
export { default as Avatar } from './ui/Avatar.svelte';
export { default as Button } from './ui/Button.svelte';
export { default as ConfirmDialog } from './ui/ConfirmDialog.svelte';
export { default as EmptyState } from './ui/EmptyState.svelte';
export { default as FloatingActionButton } from './ui/FloatingActionButton.svelte';
export { default as ListItem } from './ui/ListItem.svelte';
export { default as MediaThumb } from './ui/MediaThumb.svelte';
export { default as PhotoPickerModal } from './ui/PhotoPickerModal.svelte';
export { default as ReportDialog } from './ui/ReportDialog.svelte';
export { default as Screen } from './ui/Screen.svelte';
export { default as SearchBar } from './ui/SearchBar.svelte';
export { default as SegmentedControl } from './ui/SegmentedControl.svelte';
export { default as Skeleton } from './ui/Skeleton.svelte';
export { default as TabBar } from './ui/TabBar.svelte';
export { default as ToggleSwitch } from './ui/ToggleSwitch.svelte';
