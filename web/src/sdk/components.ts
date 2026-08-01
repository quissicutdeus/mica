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
 */
export { default as Avatar } from './ui/Avatar.svelte';
export { default as Button } from './ui/Button.svelte';
export { default as ConfirmDialog } from './ui/ConfirmDialog.svelte';
export { default as EmptyState } from './ui/EmptyState.svelte';
export { default as FloatingActionButton } from './ui/FloatingActionButton.svelte';
export { default as ListItem } from './ui/ListItem.svelte';
export { default as PhotoPickerModal } from './ui/PhotoPickerModal.svelte';
export { default as ReportDialog } from './ui/ReportDialog.svelte';
export { default as Screen } from './ui/Screen.svelte';
export { default as SearchBar } from './ui/SearchBar.svelte';
